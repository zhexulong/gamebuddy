import type { WorldBook } from "../worldbook.js";
import { ST_CARD_DECODER_LIMITS_V1 } from "./compatibility-manifest.v1.js";

/**
 * The Tavern V2/V3 card spec this builder writes.
 *
 * V3 is the superset the ST ecosystem reads from the same `data` object V2 uses,
 * and it is the version that carries `system_prompt` - the card field the import
 * folds into a companion's `characterVoice`. Writing V3 is what makes the export
 * a card our own import can read back with every field it keeps.
 */
const TAVERN_CARD_SPEC = "chara_card_v3" as const;
const TAVERN_CARD_SPEC_VERSION = "3.0" as const;

/**
 * The companion's own stored records, as the export builder reads them.
 *
 * These are the durable artifacts exactly as the import persisted them - the
 * identity profile (name, persona, few-shot examples, performance directive),
 * the scenario record, the greeting set and her own worldbook - so the builder
 * is a pure projection of records that already exist. It never reads a file and
 * never invents a value: a record the companion does not carry produces no card
 * field at all.
 */
export type CompanionCardRecords = Readonly<{
  name: string;
  persona?: Readonly<{ core?: string; interactionStyle?: string; expressionStyle?: string }>;
  examples?: readonly Readonly<{ user: string; companion: string }>[];
  characterVoice?: Readonly<{ text: string; source: "card" | "player" }>;
  /** The companion's own scenario text, verbatim (the durable record's authored text). */
  scenario?: string;
  /** The greeting variants in order; the first is the default opening. */
  openings?: readonly Readonly<{ text: string }>[];
  /**
   * Her own world book. Its entries round-trip; its book-level `alwaysOnPremise`
   * does NOT, because the ST V2/V3 `character_book` has no premise field (see
   * `bookOf`). `null`/absent is an ordinary state: she has no book.
   */
  worldBook?: WorldBook | null;
  /**
   * The card's open-by-design `extensions` object, as her own
   * `card-extensions.json` record holds it. Absent is an ordinary state: the card
   * she was imported from wrote none (or she was created directly), so the export
   * writes no `extensions` field rather than an empty object.
   */
  extensions?: Readonly<Record<string, unknown>>;
  /**
   * The author fields this product does not interpret (`creator_notes`, `tags`, `creator`,
   * `character_version`, and whatever else the format allows), as her own `card-metadata.json` holds
   * them. Absent is ordinary: the card she came from wrote none, so no field is written.
   */
  preservedFields?: Readonly<Record<string, unknown>>;
  /**
   * The card's own `post_history_instructions`, as her own record holds it. Absent when the card
   * wrote none, and then no field is written - "the card said nothing" stays distinguishable from an
   * empty string.
   */
  postHistoryInstructions?: string;
}>;

/** One entry of a V2/V3 `character_book`, under the spec's own field names. */
type TavernCardBookEntry = Readonly<{
  /** The author-facing title (the durable entry's `title`). */
  comment: string;
  content: string;
  /** The card's own trigger words; absent when the entry carries none. */
  keys?: readonly string[];
  /** Always-on membership; absent when the entry is keyword-gated. */
  constant?: boolean;
}>;

/** The V2/V3 `character_book`: the entries plus the book's declared scan depth. */
type TavernCardBook = Readonly<{
  scan_depth?: number;
  entries: readonly TavernCardBookEntry[];
}>;

/**
 * A standard Tavern V3 character card. The spec's own field names, and only the
 * fields the companion actually carries: a value she does not have is absent
 * rather than a placeholder that would import as real content.
 *
 * The mapping, one place per field (the import reads each back into the same
 * effective record):
 *
 *   card field              <- the companion's record
 *   -----------------------    -------------------------------------------------
 *   data.name               <- identity.name
 *   data.description        <- persona.core          (who she is)
 *   data.personality        <- persona.interactionStyle (how she treats the player)
 *   data.system_prompt      <- characterVoice.text    (the performance directive)
 *   data.scenario           <- the scenario record's text
 *   data.first_mes          <- openings[0].text
 *   data.alternate_greetings<- openings[1..].text, in order
 *   data.mes_example        <- examples, as `{{user}}`/`{{char}}` blocks
 *   data.character_book     <- worldBook.entries (+ worldBook.scanDepth)
 *   data.extensions         <- the card-extensions record, verbatim
 *
 * Two companion fields have no V2/V3 card field and are therefore NOT written:
 * `persona.expressionStyle` (the spec has no expression-style field at all) and
 * the world book's book-level `alwaysOnPremise` (the spec's book has no premise).
 * They are left out, never folded into a field that means something else.
 */
export type TavernCardV3 = Readonly<{
  spec: typeof TAVERN_CARD_SPEC;
  spec_version: typeof TAVERN_CARD_SPEC_VERSION;
  data: Readonly<{
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    alternate_greetings?: readonly string[];
    mes_example?: string;
    system_prompt?: string;
    character_book?: TavernCardBook;
    /**
     * The card's own open-by-design object, written back as the companion's
     * record holds it. It is inert data: no reader interprets or executes it.
     */
    extensions?: Readonly<Record<string, unknown>>;
  }>;
}>;

/** The saved card: the spec version, a filename, and the card's own JSON text. */
export type CompanionCardExport = Readonly<{
  spec: typeof TAVERN_CARD_SPEC;
  fileName: string;
  /** The card's own JSON serialization - exactly the bytes the player saves. */
  card: string;
}>;

/**
 * The two forms a companion's card can be saved in: the standard `.json` card,
 * and the `.png` card that trades her picture with it. Named, never inferred from
 * a filename - the caller says which it asked for and the Host builds that one.
 */
export type CompanionCardFormat = "json" | "png";

/**
 * Builds the V3 card from the companion's stored records.
 *
 * Pure: no I/O, no clock, no environment. Serialization is `JSON.stringify` of a
 * frozen object, so the same records always produce the same bytes.
 */
export function buildCompanionCard(records: CompanionCardRecords): TavernCardV3 {
  const persona = records.persona;
  const [first, ...alternates] = records.openings ?? [];
  const mesExample = examplesToMesExample(records.examples ?? []);
  const book = bookOf(records.worldBook);
  return Object.freeze({
    spec: TAVERN_CARD_SPEC,
    spec_version: TAVERN_CARD_SPEC_VERSION,
    data: Object.freeze({
      name: records.name,
      ...(persona?.core === undefined ? {} : { description: persona.core }),
      ...(persona?.interactionStyle === undefined ? {} : { personality: persona.interactionStyle }),
      ...(records.scenario === undefined ? {} : { scenario: records.scenario }),
      ...(first === undefined ? {} : { first_mes: first.text }),
      ...(alternates.length === 0
        ? {}
        : { alternate_greetings: Object.freeze(alternates.map((opening) => opening.text)) }),
      ...(mesExample === undefined ? {} : { mes_example: mesExample }),
      ...(records.characterVoice === undefined ? {} : { system_prompt: records.characterVoice.text }),
      ...(book === undefined ? {} : { character_book: book }),
      ...(records.extensions === undefined ? {} : { extensions: records.extensions }),
      // The card's own closing direction, written back where its author put it.
      ...(records.postHistoryInstructions === undefined
        ? {}
        : { post_history_instructions: records.postHistoryInstructions }),
      // The author fields this product does not interpret, written back verbatim. They go last and they go
      // shallowly: a field named here was the card's, not ours, so an interpreted field of the same name wins
      // and a genuinely unknown one comes back out unchanged.
      ...(records.preservedFields ?? {}),
    }),
  });
}

/**
 * The card's own JSON text, and the check that our own import would accept it.
 *
 * An export that our import refuses is not an export: the round trip is what
 * makes the file honest. Every bound here is the decoder's own
 * (`ST_CARD_DECODER_LIMITS_V1`), not a second opinion about what a card may be,
 * so a companion whose records fit inside the format yields a card that re-imports
 * and a companion whose records do not is refused by name rather than emitted as a
 * file the Host would reject on the way back in.
 */
export function exportCompanionCard(records: CompanionCardRecords): CompanionCardExport {
  const card = buildCompanionCard(records);
  const text = JSON.stringify(card);
  assertCompanionCardImportable(card);
  return Object.freeze({ spec: TAVERN_CARD_SPEC, fileName: companionCardFileName(records.name, "json"), card: text });
}

/**
 * Refuses a card the decoder would not keep whole, with one bounded code.
 *
 * The bound that fires first is not reported separately on purpose: the player's
 * fact is "her records do not fit in a card", and which field overran is a
 * decoding detail, not a decision she can act on differently.
 */
export function assertCompanionCardImportable(card: TavernCardV3): void {
  const limits = ST_CARD_DECODER_LIMITS_V1;
  const data = card.data;
  const nameBytes = utf8Bytes(data.name);
  if (nameBytes === 0 || nameBytes > limits.nameBytes) throw new Error("companion_card_too_large");
  const textFields = [
    data.description,
    data.personality,
    data.scenario,
    data.first_mes,
    ...(data.alternate_greetings ?? []),
  ];
  if (textFields.some((value) => value !== undefined && utf8Bytes(value) > limits.textBytes))
    throw new Error("companion_card_too_large");
  if (data.mes_example !== undefined && utf8Bytes(data.mes_example) > limits.examplesBytes)
    throw new Error("companion_card_too_large");
  if (data.system_prompt !== undefined && utf8Bytes(data.system_prompt) > limits.cardVoiceBytes)
    throw new Error("companion_card_too_large");
  // The card's `extensions` object, bounded by the decoder's own rule for it -
  // the length of its JSON text - so an export can never be a card whose
  // extensions the next import silently drops.
  if (data.extensions !== undefined && JSON.stringify(data.extensions).length > limits.cardExtensionsJsonChars)
    throw new Error("companion_card_too_large");
  const book = data.character_book;
  if (book !== undefined) {
    if (utf8Bytes(JSON.stringify(book)) > limits.characterBookBytes) throw new Error("companion_card_too_large");
    for (const entry of book.entries) {
      if (utf8Bytes(entry.comment) > limits.characterBookTitleBytes) throw new Error("companion_card_too_large");
      if (utf8Bytes(entry.content) > limits.characterBookEntryBytes) throw new Error("companion_card_too_large");
    }
  }
  if (utf8Bytes(JSON.stringify(card)) > limits.inputBytesJson) throw new Error("companion_card_too_large");
}

/** How much of the companion's name a filename keeps, before the extension. */
const MAX_FILE_NAME_STEM = 64;

/**
 * The filename the browser offers when it saves the card.
 *
 * The companion's own name is the file's name (what the SillyTavern ecosystem
 * does), with the characters Windows and POSIX reserve replaced - a filename is
 * not a place to discover that her name carried a path separator. A name that
 * sanitizes away to nothing falls back to the word `companion`, and the extension
 * is the form's own (`json` or `png`).
 */
export function companionCardFileName(name: string, format: CompanionCardFormat): string {
  const stem = name
    .replace(/[\\/:*?"<>|]/gu, "_")
    .replace(/[\u0000-\u001f\u007f]/gu, "_")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, MAX_FILE_NAME_STEM);
  return `${stem.length === 0 ? "companion" : stem}.${format}`;
}

/**
 * The card's `mes_example`: the reviewed few-shot rows, written with the spec's
 * own two speaker tokens so the import's own parser reads each block back into
 * the same `{user, companion}` pair.
 */
function examplesToMesExample(examples: readonly Readonly<{ user: string; companion: string }>[]): string | undefined {
  if (examples.length === 0) return undefined;
  return examples.map((example) => `{{user}}: ${example.user}\n{{char}}: ${example.companion}`).join("<START>");
}

/**
 * The card's `character_book`, or absent when the companion has no book (or an
 * empty one). A book's `alwaysOnPremise` has no V2/V3 field and is not invented;
 * the entries and the declared scan depth are the facts the format carries, and
 * both the durable entry's trigger words and its always-on flag round-trip.
 */
function bookOf(book: WorldBook | null | undefined): TavernCardBook | undefined {
  if (book === null || book === undefined || book.entries.length === 0) return undefined;
  return Object.freeze({
    ...(book.scanDepth === undefined ? {} : { scan_depth: book.scanDepth }),
    entries: Object.freeze(
      book.entries.map((entry) =>
        Object.freeze({
          comment: entry.title,
          content: entry.content,
          ...(entry.keys === undefined || entry.keys.length === 0 ? {} : { keys: Object.freeze([...entry.keys]) }),
          ...(entry.constant === true ? { constant: true } : {}),
        }),
      ),
    ),
  });
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
