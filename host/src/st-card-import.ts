import { inflateSync } from "node:zlib";
import type { IdentityProfile } from "./identity-profile.js";
import { hasUnrenderedMacro, macroTable, renderMacros, renderWorldBookText } from "./tavern/macro-engine.js";
import { DEFAULT_COMPANION_LOCALE, type CompanionLocale } from "./settings/player-preference-store.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./tavern/compatibility-manifest.v1.js";
import { isCompletePngFile } from "./tavern/companion-avatar/index.js";
import { MAX_WORLDBOOK_SCAN_DEPTH, type WorldBookEntry } from "./worldbook.js";

const MAX_JSON_DEPTH = ST_CARD_DECODER_LIMITS_V1.jsonDepth;
const MAX_JSON_NODES = ST_CARD_DECODER_LIMITS_V1.jsonNodes;
const MAX_PNG_CHUNKS = ST_CARD_DECODER_LIMITS_V1.pngChunks;
const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** Bounded rejection code for a malformed `alternate_greetings` entry. */
const INVALID_ALTERNATE_GREETINGS = "invalid_alternate_greetings";

/**
 * Bounded reasons an import can LOSE card material it was handed.
 *
 * A loss is a deliberate, bounded decision inside a field the card did supply -
 * a cap (the key list), a label the speaker parser does not accept, content
 * beyond the declared entry bound, an entry the macro set cannot render. Unlike
 * `dispositions` (whole fields accepted, kept opaque or refused) a loss is
 * *within* an accepted field, so it needs a count as well as a reason.
 *
 * The rule is "no import loss is silent": `st-card-import.test.ts` declares one
 * fixture card per reason below and fails if a fixture's loss is not reported with
 * its exact count, if a reported reason is not one the gate declares, or if the
 * reported counts do not account for every droppable item in the card. A new drop
 * that reports nothing, or reports a reason with no fixture, turns the gate red.
 */
const ST_CARD_IMPORT_LOSS_REASONS = [
  "unparsed_example_blocks",
  "worldbook_keys_truncated",
  "unrenderable_worldbook_entry",
  "worldbook_entry_content_unreadable",
  "character_voice_too_long",
  "post_history_instructions_too_long",
] as const;
export type StCardImportLossReason = (typeof ST_CARD_IMPORT_LOSS_REASONS)[number];
export type StCardImportLoss = Readonly<{
  /** The card field the material came from, e.g. `mes_example`. */
  field: string;
  reason: StCardImportLossReason;
  /** How many items were lost, always at least 1. */
  count: number;
}>;

/** The one channel an import reports a loss through. */
type StCardImportLossLedger = Readonly<{
  record(field: string, reason: StCardImportLossReason, count: number): void;
  entries(): readonly StCardImportLoss[];
}>;
function createLossLedger(): StCardImportLossLedger {
  const entries: StCardImportLoss[] = [];
  return Object.freeze({
    record(field: string, reason: StCardImportLossReason, count: number): void {
      if (count > 0) entries.push(Object.freeze({ field, reason, count }));
    },
    entries: (): readonly StCardImportLoss[] => Object.freeze([...entries]),
  });
}

type StCardImportClassification = "accepted_typed" | "preserved_opaque" | "dropped_unsupported" | "rejected_invalid";
export type StCardImportDisposition = Readonly<{
  field: string;
  classification: StCardImportClassification;
  reason: string;
}>;
export type StCardImportCandidate = Readonly<{
  profileCandidate: StCardImportPreview["profileCandidate"];
  /** Candidate-only scenario retained for review/import reporting; never profile input. */
  scenario?: string;
  /**
   * The card's standard `system_prompt` (v2/v3), carried as bounded candidate
   * text and copied into the profile as the companion's `characterVoice` so the
   * card's own performance directive reaches the model. Rendered AFTER the Host
   * floor, in its own labelled section, and never able to loosen it.
   */
  systemPrompt?: string;
  /**
   * The card's standard `post_history_instructions` (v2/v3), carried verbatim as
   * bounded candidate text so the service can keep it as the companion's own
   * durable record. It is the card's closing direction - the ST spec injects it
   * AFTER the history - so it is stored beside her scenario and her openings and
   * is deliberately not a profile field and not prompt input here.
   */
  postHistoryInstructions?: string;
  /**
   * The card's open-by-design `extensions` object, carried verbatim (bounded and
   * deep-frozen) so a consumer can read `extensions.gamebuddy.stardew` — the
   * companion's Stardew sprite mapping and stamina thresholds. Never interpreted
   * as instructions and never executed.
   */
  extensions?: Readonly<Record<string, unknown>>;
  /**
   * The card's fields this product does not interpret, carried verbatim (bounded and deep-frozen) so the
   * service can keep them as her own `card-metadata.json` and the export can write them back. This is where
   * the compatibility manifest's `preserved_opaque` classification is performed rather than merely reported.
   */
  preservedFields?: Readonly<Record<string, unknown>>;
  worldBookCandidates: readonly WorldBookEntry[];
  /**
   * The card's own `character_book.scan_depth`, when it declared a usable one.
   * It bounds how many of the newest visible messages per-turn World Info
   * selection scans, and rides the book into `worldbook.json`; absent means the
   * Host applies its documented default depth.
   */
  worldBookScanDepth?: number;
}>;
export type StCardImportReport = Readonly<{
  source: "json" | "png";
  format?: "st-v2" | "st-v3";
  candidate?: StCardImportCandidate;
  /** Soft hints for a frontend notice (never a gate) - see StCardImportPreview. */
  softHints: readonly Readonly<{ field: "core" | "interactionStyle" | "expressionStyle"; chars: number }>[];
  /** Bounded, counted losses. An import that drops material says so here. */
  losses: readonly StCardImportLoss[];
  dispositions: readonly StCardImportDisposition[];
}>;

export type StCardImportPreview = Readonly<{
  format: "st-v2" | "st-v3";
  profileCandidate: Readonly<{
    profileId: string;
    identity: Readonly<{ name: string; role: string; continuity: string }>;
    persona?: IdentityProfile["persona"];
    examples: readonly Readonly<{ user: string; companion: string }>[];
    firstGreeting?: string;
    /** The card's other openings, beside the default. These are Thread History
     *  (a new chat's first assistant message), never Stable Prefix Context. */
    alternateGreetings?: readonly string[];
  }>;
  /** Candidate-only scenario is deliberately outside the profile candidate. */
  scenario?: string;
  /** The card's standard `system_prompt`, review-visible candidate data that
   *  becomes the companion's `characterVoice` (rendered after the floor). */
  systemPrompt?: string;
  /** The card's standard `post_history_instructions`, carried verbatim and bounded. */
  postHistoryInstructions?: string;
  /** The card's open-by-design `extensions` object, carried inert and verbatim. */
  extensions?: Readonly<Record<string, unknown>>;
  /** The card's fields this product does not interpret, carried inert and verbatim. */
  preservedFields?: Readonly<Record<string, unknown>>;
  worldBookCandidates: readonly WorldBookEntry[];
  /** The card's own `character_book.scan_depth`, when it declared a usable one. */
  worldBookScanDepth?: number;
  unsupportedFields: readonly string[];
  /** The bounded, counted losses this card's import took - never silent. */
  losses: readonly StCardImportLoss[];
  /** Soft hints for a frontend notice (never a gate): unusually long persona
   *  fields that may raise per-turn token use. The player decides. */
  softHints: readonly Readonly<{ field: "core" | "interactionStyle" | "expressionStyle"; chars: number }>[];
}>;

/**
 * Safely decodes a bounded ST V2/V3 JSON payload or PNG metadata. The result
 * consists exclusively of inert data candidates; no field is executed, placed
 * into a prompt, fetched, or otherwise interpreted as instructions.
 */
export function decodeStCard(input: string | Uint8Array): StCardImportReport {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const source = isPng(bytes) ? "png" : "json";
  const maxInputBytes =
    source === "png" ? ST_CARD_DECODER_LIMITS_V1.inputBytesPng : ST_CARD_DECODER_LIMITS_V1.inputBytesJson;
  if (bytes.byteLength > maxInputBytes) return rejected(source, "input", "input_too_large");
  const json = source === "png" ? extractPngCardJson(bytes) : decodeUtf8(bytes);
  if (json === undefined)
    return rejected(source, source === "png" ? "png_metadata" : "input", "missing_or_invalid_card_payload");
  if (!hasSafeJsonShape(json)) return rejected(source, "input", "json_limits_exceeded");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return rejected(source, "input", "invalid_json");
  }
  if (!isRecord(value)) return rejected(source, "root", "card_must_be_an_object");
  return reportFromValue(value, source);
}

/**
 * A PNG card whose image the import could not keep, and why. This is the one
 * avatar fact the player is told about, because a companion who silently has no
 * picture reads as a card that never had one.
 *
 * There is no `too large` member on purpose: the avatar is the card file, so the
 * decoder's own PNG ceiling (`ST_CARD_DECODER_LIMITS_V1.inputBytesPng`, which is
 * also `MAX_COMPANION_AVATAR_BYTES`) bounds both, and a card past it is refused
 * whole - by name, as `input_too_large`, before any avatar question arises.
 */
export type StCardAvatarDropReason = "avatar_malformed";

/**
 * The card's own picture, decided from the bytes the card arrived as.
 *
 * The avatar IS the card: for a PNG card the image and the `tEXt` chunk carrying
 * the card are the same object, so there is nothing to extract - only a decision
 * about whether these bytes are a picture at all. A `.json` card has none
 * (`absent`), and a PNG that is not a structurally complete container (`no IHDR
 * first, no IEND, a chunk length past the end of the file`) is dropped by name
 * rather than stored as a file no browser could render. That last case is real:
 * the decoder finds its `tEXt` chunk wherever it lies, so a card can be perfectly
 * importable while its image is not a picture.
 */
export type StCardAvatarDecision =
  | Readonly<{ state: "present"; bytes: Uint8Array }>
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "dropped"; reason: StCardAvatarDropReason }>;

export function stCardAvatar(input: string | Uint8Array): StCardAvatarDecision {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  if (!isPng(bytes)) return Object.freeze({ state: "absent" });
  return isCompletePngFile(bytes)
    ? Object.freeze({ state: "present", bytes })
    : Object.freeze({ state: "dropped", reason: "avatar_malformed" });
}

/** Backwards-compatible preview helper for already-decoded JSON values. */
export function previewStCard(value: unknown, fallbackProfileId = "gamebuddy.companion.imported"): StCardImportPreview {
  if (!isRecord(value)) throw new Error("invalid_st_card");
  return previewFromValue(value, fallbackProfileId);
}

/**
 * Maps an imported candidate's static persona, identity and the card's own
 * performance directive into a Host IdentityProfile,
 * ensuring 100% Prefix Caching in m[0]. Card macros are rendered deterministically
 * ({{char}} → name, {{user}} → the run's own word for the player) before the profile is
 * frozen, so a card writer can use the standard ST token set without leaking raw
 * placeholders into the Tier 1 prefix. The player reference is the locale's, never the
 * English constant "the player": a Chinese card rendered into a Chinese run reads
 * 与你一同从都市迁居, in the second person the card speaks in, because the shipped
 * card forbids her to refer to the player as a third party. Rendering is single-pass
 * (renderMacros), values are re-checked by
 * validateIdentityProfile at the write boundary.
 *
 * `locale` is the run's companion language. It defaults to the product's own default
 * companion language, which is what a build-time compile of the reviewed preset (a
 * Chinese card) and any caller that has not read the player's stored preference get.
 */
export function candidateToIdentityProfile(
  previewOrCandidate: StCardImportPreview | StCardImportCandidate,
  revision = 1,
  locale: CompanionLocale = DEFAULT_COMPANION_LOCALE,
): IdentityProfile {
  const profileCandidate =
    "profileCandidate" in previewOrCandidate
      ? previewOrCandidate.profileCandidate
      : (previewOrCandidate as StCardImportPreview).profileCandidate;
  const macros = macroTable({ char: profileCandidate.identity.name, locale });
  const render = (value: string): string => renderMacros(value, macros);
  const persona =
    profileCandidate.persona === undefined
      ? undefined
      : Object.freeze({
          ...(profileCandidate.persona.core === undefined ? {} : { core: render(profileCandidate.persona.core) }),
          ...(profileCandidate.persona.interactionStyle === undefined
            ? {}
            : { interactionStyle: render(profileCandidate.persona.interactionStyle) }),
          ...(profileCandidate.persona.expressionStyle === undefined
            ? {}
            : { expressionStyle: render(profileCandidate.persona.expressionStyle) }),
        });
  const examples =
    profileCandidate.examples === undefined || profileCandidate.examples.length === 0
      ? undefined
      : Object.freeze(
          profileCandidate.examples.map((example) =>
            Object.freeze({ user: render(example.user), companion: render(example.companion) }),
          ),
        );
  // The card's own performance directive. Macros are rendered the same way the
  // persona and examples are; provenance is `card` until the player edits it.
  const characterVoice =
    typeof previewOrCandidate.systemPrompt === "string" && previewOrCandidate.systemPrompt.length > 0
      ? Object.freeze({ text: render(previewOrCandidate.systemPrompt), source: "card" as const })
      : undefined;
  return Object.freeze({
    schemaVersion: 1,
    profileId: profileCandidate.profileId,
    revision,
    identity: Object.freeze({
      name: profileCandidate.identity.name,
      role: profileCandidate.identity.role,
      continuity: profileCandidate.identity.continuity,
    }),
    ...(persona === undefined ? {} : { persona }),
    ...(examples === undefined ? {} : { examples }),
    ...(characterVoice === undefined ? {} : { characterVoice }),
  });
}

function reportFromValue(value: Record<string, unknown>, source: "json" | "png"): StCardImportReport {
  let preview: StCardImportPreview;
  try {
    preview = previewFromValue(value, "gamebuddy.companion.imported");
  } catch (error) {
    // A malformed alternates entry rejects the whole decode with one bounded
    // code: a partial variant list would be a half-written greeting record.
    if (error instanceof Error && error.message === INVALID_ALTERNATE_GREETINGS)
      return rejected(source, "alternate_greetings", INVALID_ALTERNATE_GREETINGS);
    throw error;
  }
  const data = isRecord(value.data) ? value.data : value;
  const accepted = [
    "name",
    "description",
    "personality",
    "scenario",
    "first_mes",
    "first_message",
    "mes_example",
    "alternate_greetings",
    "character_book",
    "system_prompt",
    "post_history_instructions",
    "extensions",
  ].filter((field) => data[field] !== undefined);
  const dispositions: StCardImportDisposition[] = accepted.map((field) =>
    disposition(field, "accepted_typed", "bounded_inert_candidate"),
  );
  // The fields this product does not interpret are now actually kept, not only classified. `preserved_opaque` was a
  // disposition with no record behind it: the import reported that the author's `creator_notes`, `tags`, `creator` and
  // `character_version` were preserved while keeping none of their text. The value is the card's own, copied verbatim,
  // bounded by one constant and frozen, so the export can write it back unchanged.
  const preservedFields: Record<string, unknown> = {};
  for (const field of Object.keys(data).sort()) {
    if (isExecutableControlField(field)) {
      dispositions.push(disposition(field, "dropped_unsupported", "executable_or_prompt_control_field"));
      continue;
    }
    if (accepted.includes(field) || field === "spec") continue;
    dispositions.push(disposition(field, "preserved_opaque", "not_interpreted"));
    preservedFields[field] = data[field];
  }
  return Object.freeze({
    source,
    format: preview.format,
    candidate: Object.freeze({
      profileCandidate: preview.profileCandidate,
      ...(preview.scenario === undefined ? {} : { scenario: preview.scenario }),
      ...(preview.systemPrompt === undefined ? {} : { systemPrompt: preview.systemPrompt }),
      ...(preview.postHistoryInstructions === undefined
        ? {}
        : { postHistoryInstructions: preview.postHistoryInstructions }),
      ...(preview.extensions === undefined ? {} : { extensions: preview.extensions }),
      ...(Object.keys(preservedFields).length === 0 ? {} : { preservedFields: Object.freeze(preservedFields) }),
      worldBookCandidates: preview.worldBookCandidates,
      ...(preview.worldBookScanDepth === undefined ? {} : { worldBookScanDepth: preview.worldBookScanDepth }),
    }),
    softHints: preview.softHints,
    losses: preview.losses,
    dispositions: Object.freeze(dispositions),
  });
}

function previewFromValue(value: Record<string, unknown>, fallbackProfileId: string): StCardImportPreview {
  const data = isRecord(value.data) ? value.data : value;
  const losses = createLossLedger();
  const spec = typeof value.spec === "string" ? value.spec : typeof data.spec === "string" ? data.spec : undefined;
  const format = spec === "chara_card_v3" || spec === "ccv3" ? "st-v3" : "st-v2";
  const name = boundedText(data.name, ST_CARD_DECODER_LIMITS_V1.nameBytes) ?? "Imported Companion";
  const description = boundedMultilineText(data.description, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const personality = boundedMultilineText(data.personality, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const scenario = boundedMultilineText(data.scenario, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const greeting =
    boundedMultilineText(data.first_mes, ST_CARD_DECODER_LIMITS_V1.textBytes) ??
    boundedMultilineText(data.first_message, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const alternateGreetings = readAlternateGreetings(data.alternate_greetings);
  const parsedExamples = parseExamples(
    boundedMultilineText(data.mes_example, ST_CARD_DECODER_LIMITS_V1.examplesBytes),
    losses,
  );
  // No few-shot is manufactured when the card wrote no `mes_example`. This used
  // to fold the whole opening (`first_mes`) into one example row as a "voice
  // anchor", which taught the wrong register: an opening is scene-setting prose
  // (200-500 characters on real cards), so a few-shot that IS the opening
  // teaches the model that a reply is that long, and short conversations came
  // back as long, self-narrating turns. The card format splits the two jobs -
  // `first_mes` is a Non-Permanent Token sent once when a chat opens,
  // `mes_example` is the few-shot channel - and the Host floor already carries
  // the register (`buildCompanionSystemPrompt`: first person, "Do not write long
  // speeches or essays; match the player's energy and pacing"). Like a persona
  // dimension the card never wrote, a few-shot the card never wrote is absent
  // rather than Host-authored. The opening itself is not lost: `greeting` below
  // is still the candidate's `firstGreeting`, which provisions the companion's
  // greeting set and its Message 0, and so is no import loss.
  // The card's OWN material and nothing else. `description` is who she is
  // (core); `personality` is how she treats the player (interactionStyle). The
  // ST v2/v3 spec has no expression-style field at all, so a card that never
  // wrote one simply carries none. This used to pad both missing dimensions
  // with English Host prose ("Respect the player's agency…", "Use natural
  // player-facing language…"), which rendered into the Tier-1 prefix of a
  // Chinese companion as a stiff English framework. The Host composes the
  // floor (buildCompanionSystemPrompt); a card's persona is only what the card
  // wrote.
  const persona: IdentityProfile["persona"] =
    description === undefined && personality === undefined
      ? undefined
      : Object.freeze({
          core: description ?? personality!,
          ...(description === undefined || personality === undefined ? {} : { interactionStyle: personality }),
        });
  const worldBook = extractCharacterBook(data.character_book, format, name, losses);
  const worldBookCandidates = worldBook.entries;
  // `system_prompt` is a standard v2/v3 card field: it carries the card's own
  // performance directive (the `characterVoice` the profile renders after the
  // floor) and is review-visible. It is bounded tighter than the generic text
  // ceiling because it lands in the stable Tier-1 prefix on every turn; a longer
  // directive is refused, never truncated, and the refusal is counted below.
  const rawSystemPrompt = boundedMultilineText(data.system_prompt, ST_CARD_DECODER_LIMITS_V1.textBytes);
  const systemPrompt =
    rawSystemPrompt !== undefined && utf8Bytes(rawSystemPrompt) > ST_CARD_DECODER_LIMITS_V1.cardVoiceBytes
      ? undefined
      : rawSystemPrompt;
  if (rawSystemPrompt !== undefined && systemPrompt === undefined)
    losses.record("system_prompt", "character_voice_too_long", 1);
  // `post_history_instructions` is the card's own closing direction. It is carried
  // verbatim (macros and all: rendering is not this decoder's job) so the service
  // can keep it as her own durable record. A longer one is refused by name, never
  // truncated: half a closing direction is a different instruction from the one
  // the author wrote.
  const rawPostHistoryInstructions = boundedMultilineText(
    data.post_history_instructions,
    ST_CARD_DECODER_LIMITS_V1.textBytes,
  );
  const postHistoryInstructions =
    rawPostHistoryInstructions !== undefined &&
    utf8Bytes(rawPostHistoryInstructions) > ST_CARD_DECODER_LIMITS_V1.postHistoryInstructionsBytes
      ? undefined
      : rawPostHistoryInstructions;
  if (rawPostHistoryInstructions !== undefined && postHistoryInstructions === undefined)
    losses.record("post_history_instructions", "post_history_instructions_too_long", 1);
  const extensions = readInertExtensions(data.extensions);
  const unsupportedFields = Object.keys(data).filter(isExecutableControlField).sort();
  // Product policy: limits only prevent physical blowup, never the player's
  // choices. Description text loads losslessly. A soft hint (not a gate) is
  // surfaced for unusually long persona fields so a frontend can show a brief
  // "this description is long (N chars), it may raise per-turn token use"
  // notice; the player decides and continues.
  const LONG_FIELD_SOFT_HINT_CHARS = 4_000;
  const longPersonaFields: Array<{ field: "core" | "interactionStyle" | "expressionStyle"; chars: number }> =
    persona === undefined
      ? []
      : (
          [
            ["core", persona.core],
            ["interactionStyle", persona.interactionStyle],
            ["expressionStyle", persona.expressionStyle],
          ] as const
        )
          .flatMap(([field, text]) => (text === undefined ? [] : [[field, text.length] as const]))
          .filter(([, length]) => length > LONG_FIELD_SOFT_HINT_CHARS)
          .map(([field, length]) => Object.freeze({ field, chars: length }));
  return Object.freeze({
    format,
    profileCandidate: Object.freeze({
      profileId: idFromName(name, fallbackProfileId),
      identity: Object.freeze({
        name,
        role: "the player's game companion",
        continuity: "Maintain one continuous shared experience with the player across chat and game surfaces.",
      }),
      ...(persona === undefined ? {} : { persona }),
      examples: Object.freeze(parsedExamples),
      ...(greeting === undefined ? {} : { firstGreeting: greeting }),
      ...(alternateGreetings === undefined ? {} : { alternateGreetings }),
    }),
    softHints: Object.freeze(longPersonaFields),
    losses: losses.entries(),
    ...(scenario === undefined ? {} : { scenario }),
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(postHistoryInstructions === undefined ? {} : { postHistoryInstructions }),
    ...(extensions === undefined ? {} : { extensions }),
    worldBookCandidates: Object.freeze(worldBookCandidates),
    ...(worldBook.scanDepth === undefined ? {} : { worldBookScanDepth: worldBook.scanDepth }),
    unsupportedFields: Object.freeze(unsupportedFields),
  });
}

/**
 * Decodes a card's alternate openings (ST v2/v3 `data.alternate_greetings`, a
 * `string[]`; neither spec attaches a per-entry label). These belong to Thread
 * History - the first assistant message of a new chat - and never to the Stable
 * Prefix Context, so they leave the decoder beside the default opening and no
 * further. An absent or empty list carries no field (a card without alternates
 * decodes byte-identically to before); any malformed entry fails closed with a
 * single bounded code so no half-written variant list can be produced.
 */
function readAlternateGreetings(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(INVALID_ALTERNATE_GREETINGS);
  const greetings = value.map((entry) => {
    const text = boundedMultilineText(entry, ST_CARD_DECODER_LIMITS_V1.textBytes);
    if (text === undefined) throw new Error(INVALID_ALTERNATE_GREETINGS);
    return text;
  });
  return greetings.length === 0 ? undefined : Object.freeze(greetings);
}

function extractPngCardJson(bytes: Uint8Array): string | undefined {
  let offset = 8;
  for (let count = 0; offset + 12 <= bytes.length && count < MAX_PNG_CHUNKS; count++) {
    const length = readU32(bytes, offset);
    const type = ascii(bytes.subarray(offset + 4, offset + 8));
    offset += 8;
    if (length > ST_CARD_DECODER_LIMITS_V1.inputBytesPng || offset + length + 4 > bytes.length) return undefined;
    const chunk = bytes.subarray(offset, offset + length);
    offset += length + 4;
    const text =
      type === "tEXt"
        ? pngText(chunk)
        : type === "zTXt"
          ? pngCompressedText(chunk)
          : type === "iTXt"
            ? pngInternationalText(chunk)
            : undefined;
    if (text !== undefined) {
      const kw = text.keyword.toLowerCase();
      if (kw === "chara" || kw === "ccv3" || kw === "character") return decodeCharaValue(text.value);
    }
    if (type === "IEND") break;
  }
  return undefined;
}
function decodeCharaValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return trimmed;
  const cleaned = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(cleaned) || cleaned.length % 4 !== 0) return undefined;
  return decodeUtf8(Buffer.from(cleaned, "base64"));
}
function pngText(chunk: Uint8Array): { keyword: string; value: string } | undefined {
  const split = chunk.indexOf(0);
  return split < 1
    ? undefined
    : { keyword: ascii(chunk.subarray(0, split)), value: decodeUtf8(chunk.subarray(split + 1)) ?? "" };
}
function pngCompressedText(chunk: Uint8Array): { keyword: string; value: string } | undefined {
  const split = chunk.indexOf(0);
  if (split < 1 || split + 2 > chunk.length) return undefined;
  const compressionMethod = chunk[split + 1];
  if (compressionMethod !== 0) return undefined;
  try {
    const payload = inflateSync(chunk.subarray(split + 2), {
      maxOutputLength: ST_CARD_DECODER_LIMITS_V1.inflateMaxOutputBytes,
    });
    return { keyword: ascii(chunk.subarray(0, split)), value: decodeUtf8(payload) ?? "" };
  } catch {
    return undefined;
  }
}
function pngInternationalText(chunk: Uint8Array): { keyword: string; value: string } | undefined {
  const first = chunk.indexOf(0);
  if (first < 1 || first + 3 > chunk.length) return undefined;
  const compressed = chunk[first + 1] === 1;
  if (chunk[first + 2] !== 0) return undefined;
  let offset = first + 3;
  for (let fields = 0; fields < 2; fields++) {
    const end = chunk.indexOf(0, offset);
    if (end < offset) return undefined;
    offset = end + 1;
  }
  try {
    const payload = compressed
      ? inflateSync(chunk.subarray(offset), {
          maxOutputLength: ST_CARD_DECODER_LIMITS_V1.inflateMaxOutputBytes,
        })
      : chunk.subarray(offset);
    return { keyword: ascii(chunk.subarray(0, first)), value: decodeUtf8(payload) ?? "" };
  } catch {
    return undefined;
  }
}
function hasSafeJsonShape(text: string): boolean {
  let depth = 0;
  let nodes = 0;
  let quoted = false;
  let escaped = false;
  for (const char of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      nodes++;
    } else if (char === "{" || char === "[") {
      if (++depth > MAX_JSON_DEPTH) return false;
    } else if (char === "}" || char === "]") depth--;
    if (nodes > MAX_JSON_NODES || depth < 0) return false;
  }
  return !quoted && depth === 0;
}
function rejected(source: "json" | "png", field: string, reason: string): StCardImportReport {
  return Object.freeze({
    source,
    softHints: Object.freeze([]),
    losses: Object.freeze([]),
    dispositions: Object.freeze([disposition(field, "rejected_invalid", reason)]),
  });
}
function disposition(
  field: string,
  classification: StCardImportClassification,
  reason: string,
): StCardImportDisposition {
  return Object.freeze({ field, classification, reason });
}
function playableKeys(value: unknown): Readonly<{ keys: readonly string[]; dropped: number }> {
  if (!Array.isArray(value)) return Object.freeze({ keys: Object.freeze([]), dropped: 0 });
  const usable = value.flatMap((key) => (typeof key === "string" ? [key.trim()] : [])).filter((key) => key.length > 0);
  const keys = Object.freeze(
    usable.filter((key) => key.length <= MAX_WORLDBOOK_KEY_CHARS).slice(0, MAX_WORLDBOOK_KEYS),
  );
  // The card's own trigger words the entry could not carry: the per-word bound
  // and the 16-key cap are bounded decisions, but a dropped trigger word is what
  // makes a keyword-gated entry unreachable, so the count is reported.
  return Object.freeze({ keys, dropped: usable.length - keys.length });
}
/** The card's keys one world-book entry carries. A cap, not a schema limit. */
const MAX_WORLDBOOK_KEYS = 16;
const MAX_WORLDBOOK_KEY_CHARS = 64;

/**
 * The card's `selectiveLogic`, SillyTavern's four modes for the secondary keys
 * (0 = AND ANY, 1 = NOT ALL, 2 = NOT ANY, 3 = AND ALL), or nothing when the card
 * declared none - the selector then applies its own documented default.
 */
function readSelectiveLogic(value: unknown): 0 | 1 | 2 | 3 | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 3
    ? (value as 0 | 1 | 2 | 3)
    : undefined;
}

function extractCharacterBook(
  value: unknown,
  format: "st-v2" | "st-v3",
  charName: string,
  losses: StCardImportLossLedger,
): Readonly<{ entries: readonly WorldBookEntry[]; scanDepth?: number }> {
  if (!isRecord(value) || utf8Bytes(JSON.stringify(value)) > ST_CARD_DECODER_LIMITS_V1.characterBookBytes)
    return Object.freeze({ entries: Object.freeze([]) });
  // The card's own recent-message scan window. Only a usable positive integer
  // inside the Host bound is carried; anything else leaves the book undeclared
  // and the Host applies its documented default depth rather than a widened one.
  const declaredScanDepth = value.scan_depth;
  const scanDepth =
    typeof declaredScanDepth === "number" &&
    Number.isSafeInteger(declaredScanDepth) &&
    declaredScanDepth >= 1 &&
    declaredScanDepth <= MAX_WORLDBOOK_SCAN_DEPTH
      ? declaredScanDepth
      : undefined;
  const entries = Array.isArray(value.entries)
    ? value.entries
    : isRecord(value.entries)
      ? Object.values(value.entries)
      : undefined;
  if (entries === undefined) return Object.freeze({ entries: Object.freeze([]) });
  const candidates: WorldBookEntry[] = [];
  let unreadableContent = 0;
  let unrenderableContent = 0;
  let truncatedKeys = 0;
  let truncatedSecondaryKeys = 0;
  entries.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    // The card's own `enabled: false` is the author saying "this entry does not
    // ship". Honouring it is not a loss - nothing the card wanted is dropped - so
    // nothing is recorded against it; shipping it would import a setting the
    // author switched off, and a keyword-gated entry would then fire on its own
    // trigger words and ride into her context.
    if (raw.enabled === false) return;
    const content = boundedMultilineText(raw.content, ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes);
    if (content === undefined) {
      // Content the card DID write but this import cannot read: beyond the
      // declared entry bound, the wrong type, or carrying control characters.
      if (raw.content !== undefined) unreadableContent += 1;
      return;
    }
    // Card macros are part of the format, and rendering them is the READER's job, not this
    // decoder's: every reader renders at its own seam (`worldbook.ts:231-232` for the World Info
    // tools, `catalog-service.ts:630-631` for the authored-context catalog,
    // `companion-world-book-service.ts:155` for the surface), and the world book's own edit path
    // already keeps the authored body for exactly this reason
    // (`companion-world-book-service.ts:346`). Storing the rendered text here froze ONE run's
    // rendering into her book - `{{char}}` became 琥珀 - and the card export writes that stored
    // text straight back, so a re-exported card no longer said `{{char}}` and was no longer the
    // same character in another Tavern.
    //
    // The render is still performed, but ONLY as the probe: an entry whose macro set cannot fully
    // render is dropped rather than written into her world book, and the drop is counted below,
    // never silent. The value STORED is the author's own text; the value TESTED is the rendering.
    if (hasUnrenderedMacro(renderWorldBookText(content, { char: charName }))) {
      unrenderableContent += 1;
      return;
    }
    const title = renderWorldBookText(
      boundedText(raw.comment, ST_CARD_DECODER_LIMITS_V1.characterBookTitleBytes) ??
        boundedText(raw.name, ST_CARD_DECODER_LIMITS_V1.characterBookTitleBytes) ??
        `Imported background ${index + 1}`,
      { char: charName },
    );
    // The card's OWN trigger words. The title is the author-facing `comment` ("大肥鱼家族"), while a
    // player says "大肥鱼"; volatile selection matches `corpus.includes(key)`, so dropping `keys` made
    // every keyword-gated entry unreachable no matter how correct the rest of the chain was.
    //
    // Carried only when the card actually supplied usable words: the worldbook validator treats an
    // EMPTY key list as invalid, so a card declaring `keys: []` must read as "no trigger words"
    // (the field stays absent) rather than as a malformed entry.
    const { keys, dropped } = playableKeys(raw.keys);
    truncatedKeys += dropped;
    // The card's SECONDARY trigger words and the logic that combines them. Reading only
    // `keys` and dropping these made an authored "only when this other word is also said"
    // rule unreachable: the selector implements all four modes, but no imported entry
    // ever reached it with a secondary gate.
    const { keys: secondaryKeys, dropped: droppedSecondaryKeys } = playableKeys(raw.secondary_keys);
    truncatedSecondaryKeys += droppedSecondaryKeys;
    const selectiveLogic = readSelectiveLogic(raw.selectiveLogic);
    candidates.push(
      Object.freeze({
        entryId: `st-${format}-${index + 1}`,
        title,
        content,
        scope: "setting" as const,
        provenance: "st-card-import" as const,
        tokenBudget: "small" as const,
        // The card's own always-on flag survives the projection: a card author
        // who wrote `constant: true` means "the companion always carries this",
        // and that review-visible membership is what the Game surface later
        // materializes into the m[0] lorebook_constant source. Keyword-gated
        // entries (constant false) stay behind the lookup tools.
        ...(raw.constant === true ? { constant: true } : {}),
        ...(keys.length === 0 ? {} : { keys }),
        ...(secondaryKeys.length === 0 ? {} : { secondaryKeys }),
        ...(selectiveLogic === undefined ? {} : { selectiveLogic }),
      }),
    );
  });
  losses.record("character_book.entries", "worldbook_entry_content_unreadable", unreadableContent);
  losses.record("character_book.entries", "unrenderable_worldbook_entry", unrenderableContent);
  losses.record("character_book.keys", "worldbook_keys_truncated", truncatedKeys);
  losses.record("character_book.secondary_keys", "worldbook_keys_truncated", truncatedSecondaryKeys);
  return Object.freeze({
    entries: Object.freeze(candidates),
    ...(scanDepth === undefined ? {} : { scanDepth }),
  });
}
/**
 * How one example block is separated from the next.
 *
 * `<START>` is the spec's own explicit separator, so a card that wrote one is
 * split on it alone. A card without `<START>` separates blocks with a new
 * speaker turn; the decoder's own unit is one user+companion exchange, so the
 * boundary is the next USER label (the labels this decoder accepts). It is
 * deliberately NOT a blank line: an example reply may span paragraphs, and the
 * old `\n{2,}` split cut such a reply in two and recorded its tail as an
 * unparsed block. For the same reason it is not the companion's label either -
 * splitting there would divide the very pair the decoder needs and lose every
 * clean card.
 */
const EXAMPLE_BLOCK_SEPARATOR = /<START>/u;
const EXAMPLE_TURN_BOUNDARY = /(?=(?:^|\n)\s*(?:\{\{user\}\}|You|User)\s*:)/iu;

function parseExamples(
  value: string | undefined,
  losses: StCardImportLossLedger,
): readonly Readonly<{ user: string; companion: string }>[] {
  if (value === undefined) return [];
  const blocks = (value.includes("<START>") ? value.split(EXAMPLE_BLOCK_SEPARATOR) : value.split(EXAMPLE_TURN_BOUNDARY))
    .map((part) => part.trim())
    .filter(Boolean);
  const parsed = blocks.flatMap((part) => {
    const user = part
      .match(/(?:\{\{user\}\}|You|User)\s*:\s*([\s\S]*?)(?=(?:\{\{char\}\}|Character|Assistant)\s*:|$)/iu)?.[1]
      ?.trim();
    const companion = part
      .match(/(?:\{\{char\}\}|Character|Assistant)\s*:\s*([\s\S]*?)(?=(?:\{\{user\}\}|You|User)\s*:|$)/iu)?.[1]
      ?.trim();
    return user !== undefined && companion !== undefined && user.length > 0 && companion.length > 0
      ? [Object.freeze({ user, companion })]
      : [];
  });
  // The accepted speaker labels are exactly `{{user}}`/`You`/`User` for the
  // player and `{{char}}`/`Character`/`Assistant` for the companion (the ST
  // spec's own two speakers, case-insensitively). A card whose examples use any
  // other label - a literal character name is the common one - loses that block,
  // and a card's own form teaching may be nothing BUT those blocks, so the loss
  // is reported with its count rather than vanishing.
  losses.record("mes_example", "unparsed_example_blocks", blocks.length - parsed.length);
  return Object.freeze(parsed);
}
/**
 * Fields whose values are executable or prompt-placement controls: the Host
 * never interprets them and a companion surface must never execute them. These
 * are the only fields the decoder drops.
 *
 * `system_prompt`, `post_history_instructions` and `extensions` are deliberately
 * NOT here: `system_prompt` is a standard card field carried as the companion's
 * `characterVoice` (and review-visible), `post_history_instructions` is her own
 * closing direction carried as her own record, `extensions` is open by design and
 * carried verbatim, and any other field that maps nowhere is classified
 * `preserved_opaque` rather than silently dropped.
 */
function isExecutableControlField(key: string): boolean {
  return /^(?:regex(?:es)?|macros?|stscript|script|quick_?repl(?:ies)?|html|prompt_?order)$/iu.test(key);
}

/**
 * Carries a card's open-by-design `extensions` object as bounded inert data.
 *
 * The value is JSON round-tripped and deep-frozen, so it is a private copy that
 * cannot be mutated back into the import, and its text is bounded by the same
 * 8192-character ceiling a reviewed candidate field carries.
 */
const MAX_INERT_EXTENSIONS_CHARS = ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars;
function readInertExtensions(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value) || Object.keys(value).length === 0) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  if (text.length === 0 || text.length > MAX_INERT_EXTENSIONS_CHARS) return undefined;
  return deepFreezeInert(JSON.parse(text)) as Readonly<Record<string, unknown>>;
}
function deepFreezeInert(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeInert(child);
  return Object.freeze(value);
}
function idFromName(name: string, fallback: string): string {
  const id = name
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 96);
  return id.length > 0 ? `gamebuddy.companion.${id}` : fallback;
}
function boundedText(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    utf8Bytes(value) > 0 &&
    utf8Bytes(value) <= max &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
    ? value
    : undefined;
}
function boundedMultilineText(value: unknown, max: number): string | undefined {
  return typeof value === "string" &&
    utf8Bytes(value) > 0 &&
    utf8Bytes(value) <= max &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
    ? value
    : undefined;
}
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
function decodeUtf8(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}
function isPng(value: Uint8Array): boolean {
  return value.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, index) => value[index] === byte);
}
function readU32(value: Uint8Array, offset: number): number {
  return ((value[offset]! << 24) >>> 0) + (value[offset + 1]! << 16) + (value[offset + 2]! << 8) + value[offset + 3]!;
}
function ascii(value: Uint8Array): string {
  return String.fromCharCode(...value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
