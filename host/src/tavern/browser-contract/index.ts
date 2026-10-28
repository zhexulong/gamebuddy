import { type Static, type TSchema, Type } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { Format } from "typebox/format";

import { ST_CARD_DECODER_LIMITS_V1 } from "../compatibility-manifest.v1.js";

export const TAVERN_BROWSER_API_V1 = "tavern_browser_api/v1" as const;
export const TAVERN_BROWSER_API_VERSION = 1 as const;

/**
 * Ceiling for NFC UTF-8 text the browser may send (message text and other player-authored
 * strings). Exported because a transport body limit has to be derived from it rather than
 * guessed: the check runs on the DECODED string, so a valid body can be up to six times this
 * (JSON escapes one character as `\uXXXX`).
 */
export const MAX_TEXT_UTF8_BYTES = 16_384;
/**
 * The most characters the player's own Game prompt addition may hold.
 *
 * ONE bound, and this is its authority. A free-text field the player types into needs a ceiling
 * for two concrete reasons, neither of them theoretical:
 *
 *  - it is written into the system prompt of every Game session that follows, so an unbounded
 *    field would let a settings control displace the Host floor by sheer length - the floor is
 *    an addition's surroundings, not a competing one, and the prompt has a real token bill;
 *  - it is stored in a JSON record read at every Game session start, so the ceiling is also the
 *    size of that read.
 *
 * 2000 characters is roughly the length of the floor and the interaction conduct together, so a
 * player can say what they want at least as fully as the Host says what it requires, and no
 * further. It is counted in UTF-16 code units, which is what the browser's own `maxLength` and
 * `String.length` count, so the textarea, the counter the player reads and this wire all refuse
 * the same input at the same point.
 *
 * `dialogue-web/src/management-pipeline-api.ts` mirrors the number as
 * `MAX_GAME_PROMPT_ADDITION_CHARS`; a test there pins the two to one value.
 */
export const MAX_GAME_PROMPT_ADDITION_CHARS = 2000;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const OPAQUE_HANDLE_PATTERN = "^[A-Za-z0-9_-]{22,128}$";
// A model id and a thinking level are the player's own input (design/28 §2.3.1):
// a general bounded string, never a closed union and never a catalog membership
// test. The recommended catalog is guidance only.
const MODEL_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:/\\-]{0,127}$";
/**
 * The model id ceiling this contract uses wherever a model id appears. The pattern above already
 * enforces it (`{0,127}` after one leading character), and it is the same ceiling
 * `PLAYER_MODEL_ID_PATTERN` in `host/src/runtime-identity.ts` enforces, so a listing id that the
 * product would refuse as a model id can never reach the wire.
 */
const MODEL_ID_MAX_LENGTH = 128;
const THINKING_LEVEL_PATTERN = "^[A-Za-z][A-Za-z0-9_-]{0,31}$";
const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9_-]{22}$";

/** Pure validators registered once for schemas compiled by this module. */
const hasUnpairedUtf16Surrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
};
const isNfcUtf8Text = (value: string): boolean =>
  !hasUnpairedUtf16Surrogate(value) &&
  value === value.normalize("NFC") &&
  new TextEncoder().encode(value).byteLength <= MAX_TEXT_UTF8_BYTES;
const isMemoryText = (value: string): boolean =>
  !hasUnpairedUtf16Surrogate(value) &&
  value === value.normalize("NFC") &&
  new TextEncoder().encode(value).byteLength <= 4096;
/**
 * The player's Game prompt addition, bounded in the SAME unit the browser counts.
 *
 * `Type.String({ maxLength })` counts Unicode code points, while the textarea's `maxLength` and
 * the player-facing counter count UTF-16 code units. A field holding 2000 astral characters is
 * 2000 code points and 4000 code units, so a `maxLength` schema would accept text the browser's
 * own control refuses to produce, and the two halves of one bound would disagree about the same
 * string. This format is the bound spelled once, in the unit the player types in.
 *
 * A lone surrogate is refused here rather than downstream: the value is written into a prompt and
 * into a JSON record, and half a code point is not text either one can carry.
 */
const isGamePromptAdditionText = (value: string): boolean =>
  !hasUnpairedUtf16Surrogate(value) && value.length <= MAX_GAME_PROMPT_ADDITION_CHARS;
const isCanonicalUnpaddedBase64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
  const finalValue = BASE64URL_ALPHABET.indexOf(value.at(-1)!);
  return value.length % 4 === 0 || (value.length % 4 === 2 ? finalValue % 16 === 0 : finalValue % 4 === 0);
};
Format.Set("tavern-browser-nfc-utf8-text-v1", isNfcUtf8Text);
Format.Set("tavern-browser-memory-text-v1", isMemoryText);
Format.Set("tavern-browser-game-prompt-addition-v1", isGamePromptAdditionText);
Format.Set("tavern-browser-canonical-base64url-v1", isCanonicalUnpaddedBase64Url);

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const ApiVersion = Type.Literal(TAVERN_BROWSER_API_VERSION);
const OpaqueHandle = Type.String({
  minLength: 22,
  maxLength: 128,
  pattern: OPAQUE_HANDLE_PATTERN,
  format: "tavern-browser-canonical-base64url-v1",
});
const IdempotencyKey = Type.String({
  minLength: 22,
  maxLength: 22,
  pattern: IDEMPOTENCY_KEY_PATTERN,
  format: "tavern-browser-canonical-base64url-v1",
});
const Revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const PositiveGeneration = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const BoundedText = Type.String({ minLength: 1, format: "tavern-browser-nfc-utf8-text-v1" });
const MemoryText = Type.String({ minLength: 1, format: "tavern-browser-memory-text-v1" });
/** Player display title: NFC bounded text, 1..120 chars (exact store ceiling). */
const TitleText = Type.String({ minLength: 1, maxLength: 120, format: "tavern-browser-nfc-utf8-text-v1" });
const ProblemCode = Type.Union([
  Type.Literal("unauthorized"),
  Type.Literal("csrf_failed"),
  Type.Literal("invalid_request"),
  Type.Literal("unsupported_api_version"),
  Type.Literal("profile_operation_unavailable"),
  Type.Literal("st_card_import_rejected"),
  Type.Literal("character_import_not_found"),
  Type.Literal("character_import_review_invalid"),
  Type.Literal("character_import_confirm_invalid"),
  Type.Literal("selection_conflict"),
  Type.Literal("draft_conflict"),
  Type.Literal("idempotency_conflict"),
  Type.Literal("idempotency_in_progress"),
  Type.Literal("idempotency_expired"),
  Type.Literal("turn_busy"),
  Type.Literal("stream_resync_required"),
  Type.Literal("selection_busy"),
  Type.Literal("turn_not_active"),
  Type.Literal("turn_already_terminal"),
  Type.Literal("runtime_unavailable"),
  Type.Literal("presentation_unavailable"),
  Type.Literal("storage_unavailable"),
  Type.Literal("state_reconciliation_required"),
  Type.Literal("settings_revision_conflict"),
  // design/28 §5.3: an activation may not switch a running turn.
  Type.Literal("dialogue_busy"),
  Type.Literal("connection_not_found"),
  Type.Literal("connection_not_ready"),
  Type.Literal("connection_conflict"),
  Type.Literal("connection_limit_reached"),
  // design/28 §2 Character/Persona rows: library + authored-content operations.
  Type.Literal("companion_not_found"),
  Type.Literal("companion_conflict"),
  Type.Literal("persona_conflict"),
  Type.Literal("scenario_conflict"),
  Type.Literal("greeting_conflict"),
  Type.Literal("authored_content_invalid"),
  // The new-chat opening variant choice (`chat.opening`): the mounted chat's opening may be
  // changed only while `opening_locked_at_event_id` is null, so each way it can be refused is a
  // distinct, bounded fact the player can act on.
  Type.Literal("chat_opening_locked"),
  Type.Literal("chat_opening_not_greeting"),
  Type.Literal("chat_opening_variant_not_found"),
  // Discarding one variant of a reply (`chat.swipe.remove`). The one refusal that is not borrowed from
  // the swipe family's own row checks is the position that would be left with no words at all: a reply
  // with nothing to read is not a state the transcript has, and removing the reply itself is the delete.
  Type.Literal("chat_swipe_last_variant"),
  // Rewinding the conversation to an earlier message (`chat.rewind`) is one mutation over two
  // authorities - the visible transcript and the model's own session - so every way it can be
  // refused is its own bounded fact about the point the player named: a handle this Chat does not
  // carry, a view of the transcript that has already moved, the greeting the Chat opened on as the
  // target, or a reply that is still being written.
  Type.Literal("chat_message_not_found"),
  Type.Literal("chat_message_revision_conflict"),
  Type.Literal("chat_rewind_opening_retained"),
  Type.Literal("chat_rewind_turn_active"),
  // Editing one of the player's own messages, her reply, or the greeting the Chat opened on (`chat.edit`),
  // in place, is the same shape of bounded vocabulary: the row is neither the player's own words, her
  // reply, nor that opening; or a reply is being written from the very text the edit would replace. Each is
  // a fact the surface can state plainly, so no edit ever fails with "the conversation could not be
  // changed" about a message the player can see.
  Type.Literal("chat_edit_turn_active"),
  // Deleting one message out of the middle of a conversation (`chat.delete`) has its own bounded
  // vocabulary, and one member of it is the whole reason the operation needed a durable record: the
  // greeting the Chat opened on, a reply that is still being written, and a row whose model entry the
  // Host never recorded - the honest answer for every row written before that binding existed.
  Type.Literal("chat_delete_opening_retained"),
  Type.Literal("chat_delete_turn_active"),
  Type.Literal("chat_delete_binding_unavailable"),
  // Chat management (`chat.rename` / `chat.archive` / `chat.restore` / `chat.trash`) names any
  // Chat of the mounted companion/continuity by its opaque handle, not only the mounted one. A
  // handle that names no Chat of this partition is a bounded, player-actionable "not found" - the
  // request never named a selection, so a selection conflict would describe a request that was
  // not made.
  Type.Literal("chat_not_found"),
  // A durable companion record that is absent, incomplete or unreadable is a data-integrity
  // fact, not a runtime outage: it is bounded and never retryable, so the player is not told
  // to retry something that cannot succeed by retrying.
  Type.Literal("companion_record_unreadable"),
  // The companion's performance directive is a durable profile field edited against an exact
  // profile revision; a stale edit is its own bounded, non-retryable-by-repeating fact.
  Type.Literal("character_voice_conflict"),
  // ...and a save that would carry the profile to the Chats that pin it is refused while one of
  // them is answering: the accepted turn's authored-context plan pins the same profile triple and
  // is write-once, so moving it under the turn would make that record describe a state the turn
  // was never in. Its own code, because "save again once the reply finishes" is what the player
  // must do and a revision conflict would tell them to reload instead.
  Type.Literal("character_voice_turn_active"),
  // The companion's own world book (`companion.worldbook.update`) is one durable file
  // replaced whole, so an edit is CASed on the revision the browser read. Each way it can
  // be refused names itself rather than collapsing into "failed": the book moved on since
  // that read, there is no book to edit, or the entries are not a book the persistent
  // validator accepts. A player cannot act on "the world book could not be saved".
  Type.Literal("companion_world_book_conflict"),
  Type.Literal("companion_world_book_absent"),
  // The one state a retry cannot fix: the book was replaced and the threads that pin the
  // revision it replaced could not be carried along. Its own code, because reporting it as
  // a clean storage failure would tell the player nothing about what is now inconsistent.
  Type.Literal("companion_world_book_binding_partial"),
  // The managed World Info library's own refusals (`world-info.detail`/`create`/`update`/`delete`).
  // Each names exactly what happened - the item is gone, its title is taken, the edit raced a newer
  // revision, or the mounted Chat still reads it - because a generic failure tells the player
  // nothing about which of the four they must act on.
  Type.Literal("world_info_not_found"),
  Type.Literal("world_info_already_exists"),
  Type.Literal("world_info_revision_conflict"),
  Type.Literal("world_info_in_use"),
  // `companion.card.export` refuses by name when a companion's own records will not
  // fit a Tavern card our import accepts. It is a bounded, non-retryable fact about
  // her data rather than a runtime outage, so it is not collapsed into
  // storage/runtime unavailable: the card cannot be made smaller by trying again.
  Type.Literal("companion_card_too_large"),
  // `companion.card.export` refuses the PNG form by name when she has no picture
  // to put in it: a PNG card must contain an image, and this Host does not invent
  // one. It is a bounded, non-retryable fact about her own records - the JSON card
  // carries them without a picture - so it is not collapsed into storage/runtime
  // unavailable.
  Type.Literal("companion_card_image_absent"),
  // `companion.avatar.update` refuses a picture it will not keep by name, and each
  // refusal is a different fact about the file the player picked: it is over the same
  // ceiling the avatar module reads by, or its bytes are not a structurally complete
  // PNG. Neither is a runtime outage - retrying the same file cannot fix either - so
  // neither is collapsed into storage/runtime unavailable.
  Type.Literal("companion_avatar_too_large"),
  Type.Literal("companion_avatar_malformed"),
  // `companion.delete` refuses to remove the companion who is in play: her Chats
  // are the mounted conversation, so deleting her would take the conversation the
  // player is having. It is the one refusal the surface must never hide behind a
  // generic failure, and the one the control itself is absent for.
  Type.Literal("companion_delete_in_play"),
]);

/**
 * `label` is the plain position (`1/2`) the browser prints between its own arrow icons; the Host
 * publishes no arrows of its own.
 */
export const BrowserSwipeInfoV1Schema = strictObject({
  currentIndex: Revision,
  totalSwipes: PositiveGeneration,
  label: Type.String({ minLength: 1, maxLength: 32 }),
  hasPrevious: Type.Boolean(),
  hasNext: Type.Boolean(),
});

/**
 * Additive v1 field for the one message whose opening is a reviewed greeting set
 * (message zero with `kind === "opening"`). It names the committed variant and its position in
 * the greeting set the Host drew it from, so the browser can show `< 1/N >` on the first message
 * without guessing. `index` is 0-based; `label` is the greeting's own authored label, null when
 * the greeting has none. `locked` is the durable `opening_locked_at_event_id` fact: once the
 * opening has been sealed by a player/companion message the choice can no longer change, and the
 * control must then be absent rather than offered and refused.
 */
export const BrowserOpeningVariantV1Schema = strictObject({
  variantId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]{1,128}$" }),
  index: Revision,
  count: PositiveGeneration,
  label: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  locked: Type.Boolean(),
});
export const BrowserMessageV1Schema = strictObject({
  handle: OpaqueHandle,
  role: Type.Union([Type.Literal("player"), Type.Literal("companion")]),
  text: BoundedText,
  locale: Type.Union([Type.Literal("en"), Type.Literal("zh-CN"), Type.Literal("und")]),
  order: Revision,
  revision: Revision,
  swipeInfo: Type.Optional(BrowserSwipeInfoV1Schema),
  openingVariant: Type.Optional(BrowserOpeningVariantV1Schema),
});
export const BrowserTurnV1Schema = strictObject({
  handle: OpaqueHandle,
  state: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("response_visible"),
    Type.Literal("stopping"),
    Type.Literal("completed"),
    Type.Literal("cancelled"),
    Type.Literal("failed"),
  ]),
  projectionRevision: Revision,
  canCancel: Type.Boolean(),
  problemCode: Type.Optional(
    Type.Union([
      Type.Literal("interrupted"),
      Type.Literal("no_visible_presentation"),
      Type.Literal("runtime_unavailable"),
      Type.Literal("storage_unavailable"),
    ]),
  ),
  /**
   * Additive v1 fact about the generation that produced the reply the player can
   * read: the model stopped at its own output ceiling, so that reply is a prefix
   * of what she was writing and asking again is how to get a whole one. It is
   * present only when the provider said so; absent means every other stop reason,
   * and also a provider that reported none, because a cut-off reply and a
   * finished one cannot be told apart from the text - and an absent fact says
   * nothing rather than claiming the reply is complete. It describes THIS turn's
   * own generation, so a later regenerate of the same reply is a turn of its own
   * and neither inherits nor lends the fact.
   */
  truncated: Type.Optional(Type.Literal(true)),
});
export const BrowserDraftV1Schema = strictObject({
  apiVersion: ApiVersion,
  revision: Revision,
  text: Type.Union([BoundedText, Type.Null()]),
});
/**
 * One safe bounded Memory row the browser may see. The handle is an opaque
 * projected handle (never the vendor CAS `stateToken`, which exceeds the
 * frozen handle bound); the title is a fixed category label and never derives
 * from stored content. `sourceRefs` and the raw state token never leave the Host.
 */
export const MemoryItemV1Schema = strictObject({
  handle: OpaqueHandle,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  content: MemoryText,
  category: Type.Union([Type.Literal("semantic"), Type.Literal("interaction")]),
  status: Type.Union([Type.Literal("active"), Type.Literal("permanent"), Type.Literal("archived")]),
  /**
   * Whose memory this is: the player's own writing, or the companion's. The management surface has
   * always let a player edit or archive either kind, but it could not TELL THEM APART - and a memory
   * list where "I told her this" and "she remembers this" look identical is one a player cannot
   * audit. The store's finer vocabulary (historian/agent/dreamer) is mapped in the Host; the browser
   * only needs the distinction that changes what a player does next.
   */
  origin: Type.Union([Type.Literal("player"), Type.Literal("companion")]),
  pinned: Type.Boolean(),
});
/**
 * One narrative chapter of the companion's long-term memory: the stretch of time it covers, the body,
 * and whether the player has touched it.
 *
 * A chapter is the same kind of thing as a Memory row - Magic Context produced it, the player reads it
 * here - so it follows the same rule: the player may correct it or remove it. `status` names which text is
 * shown (`sealed` is the fold's own, `edited` is the player's), and `deleted` is a tombstone the panel
 * still lists, so a removal stays visible instead of quietly vanishing from a history the player is
 * auditing.
 */
export const MemoryChapterV1Schema = strictObject({
  handle: OpaqueHandle,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  /** The covered span, already rendered ("2026-10-01→2026-10-03") so no client formats dates. */
  span: Type.String({ minLength: 1, maxLength: 128 }),
  content: MemoryText,
  status: Type.Union([Type.Literal("sealed"), Type.Literal("edited"), Type.Literal("deleted")]),
  /** True when the player's own text or removal is what stands, so the panel can say whose words these are. */
  editedByPlayer: Type.Boolean(),
});
/**
 * Read-only Memory projection for the exact mounted continuity (design/40 P8
 * item 4 / design/78 Task 6). `projectionRevision` is an opaque content
 * fingerprint of the projected rows so a client can detect a changed set;
 * it is not a storage revision and never carries a durable identifier.
 */
export const MemoryReadV1Schema = strictObject({
  apiVersion: ApiVersion,
  projectionRevision: OpaqueHandle,
  memories: Type.Array(MemoryItemV1Schema),
  /** The continuity's narrative chapters, oldest first. Continuity-scoped, like every other panel read. */
  chapters: Type.Array(MemoryChapterV1Schema),
});
/**
 * Player-authored ordinary Memory CRUD. The browser provides only opaque
 * projection facts; the Host resolves them to a current vendor row before a
 * vendor-owned state-token CAS. No provider, Pi session, receipt or evidence
 * fact is expressible by this command.
 */
export const MemoryMutationCommandV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("create"),
    expectedProjectionRevision: OpaqueHandle,
    content: MemoryText,
  }),
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("update"),
    expectedProjectionRevision: OpaqueHandle,
    handle: OpaqueHandle,
    content: MemoryText,
  }),
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("archive"),
    expectedProjectionRevision: OpaqueHandle,
    handle: OpaqueHandle,
  }),
  /** Replace a chapter's body with the player's words; the fold's own span and title do not move. */
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("update_chapter"),
    expectedProjectionRevision: OpaqueHandle,
    handle: OpaqueHandle,
    content: MemoryText,
  }),
  /** Remove a chapter: a tombstone, so the span stays covered and a later fold cannot re-derive it. */
  strictObject({
    apiVersion: ApiVersion,
    operation: Type.Literal("delete_chapter"),
    expectedProjectionRevision: OpaqueHandle,
    handle: OpaqueHandle,
  }),
]);
/** Every successful mutation returns the same safe fresh read model. */
export const MemoryMutationResultV1Schema = MemoryReadV1Schema;

/**
 * Reviewed ST-card import pipeline (design/28 Import/export row).
 *
 * One Host-minted opaque importId per card submission; four operations:
 *   stage   POST /imports                — submit a character card JSON (bounded)
 *   read    GET  /imports/:importId      — safe review data (fields + dispositions)
 *   review  POST /imports/:importId/review  — record explicit eligible-field review
 *   confirm POST /imports/:importId/confirm— provision the reviewed companion
 *
 * The card body is the ONLY input the player submits. Everything read back is a
 * derived, player-readable projection: candidate field summaries (field,
 * eligibility, char count — never body text), inert disposition rows, and the
 * confirmed companion name. Unsupported card content is shown as not included
 * and never executed.
 */
export const StCardImportFieldSummaryV1Schema = strictObject({
  field: Type.String({ minLength: 1, maxLength: 64 }),
  eligibility: Type.Union([
    Type.Literal("candidate_only"),
    Type.Literal("profile_eligible_after_explicit_review"),
    Type.Literal("never_runtime"),
  ]),
  chars: Revision,
});
export const StCardImportDispositionV1Schema = strictObject({
  field: Type.String({ minLength: 1, maxLength: 128 }),
  classification: Type.Union([
    Type.Literal("accepted_typed"),
    Type.Literal("preserved_opaque"),
    Type.Literal("dropped_unsupported"),
    Type.Literal("rejected_invalid"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 128 }),
});
/**
 * One counted loss inside an accepted field (a card's own directive beyond the
 * voice bound is `system_prompt` / `character_voice_too_long`). It is the
 * decoder's own loss ledger, surfaced so a review never has to infer a loss.
 */
export const StCardImportLossV1Schema = strictObject({
  field: Type.String({ minLength: 1, maxLength: 128 }),
  reason: Type.String({ minLength: 1, maxLength: 128 }),
  count: Revision,
});
/**
 * The card-file ceiling, base64-inflated: `ST_CARD_DECODER_LIMITS_V1.inputBytesPng`
 * is the decoder's own limit on a PNG card's bytes, and base64 costs 4 characters
 * per 3 bytes. Computed from that one number rather than spelled again, so the
 * wire and the decoder can never disagree about what a card file may be.
 */
const MAX_PNG_CARD_BASE64_CHARS = Math.ceil(ST_CARD_DECODER_LIMITS_V1.inputBytesPng / 3) * 4;
/**
 * The stage route's request-body ceiling: the union's larger arm plus a small
 * JSON envelope. Base64 uses no character JSON escapes, so the margin only has
 * to cover the field names - unlike a decoded-text limit, which a `\uXXXX`
 * escape can inflate sixfold (`MAX_TEXT_UTF8_BYTES`).
 */
export const MAX_ST_CARD_IMPORT_BODY_BYTES = MAX_PNG_CARD_BASE64_CHARS + 8_192;
/**
 * `character.import.stage`'s body: a bounded tagged union, because a card on
 * disk is one of exactly two things and the Host must know which without
 * guessing.
 *
 *  - `json`: the card's own text - a `.json` file, or text the player pasted.
 *  - `png`: the WHOLE picked file, base64. A PNG card's picture and the `tEXt`
 *    chunk carrying its card are the same object, so a browser that sent the
 *    card's fields and its picture as two fields would be asserting a pairing no
 *    Host could check. Sending the file makes the pairing structural: the Host's
 *    own decoder reads the card's fields and its picture out of the one byte
 *    string the Host itself read.
 */
export const StageStCardImportCommandV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    cardSource: Type.Literal("json"),
    card: Type.String({ minLength: 1, maxLength: ST_CARD_DECODER_LIMITS_V1.inputBytesJson }),
  }),
  strictObject({
    apiVersion: ApiVersion,
    cardSource: Type.Literal("png"),
    cardFileBase64: Type.String({ minLength: 1, maxLength: MAX_PNG_CARD_BASE64_CHARS }),
  }),
]);
export const StCardImportStageResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  importId: OpaqueHandle,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  candidateRevision: Revision,
  fields: Type.Array(StCardImportFieldSummaryV1Schema, { maxItems: 32 }),
  dispositions: Type.Array(StCardImportDispositionV1Schema, { maxItems: 128 }),
  losses: Type.Optional(Type.Array(StCardImportLossV1Schema, { maxItems: 64 })),
});
export const StCardImportReadResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  importId: OpaqueHandle,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  candidateRevision: Revision,
  reviewed: Type.Boolean(),
  reviewedFields: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
  fields: Type.Array(StCardImportFieldSummaryV1Schema, { maxItems: 32 }),
  dispositions: Type.Array(StCardImportDispositionV1Schema, { maxItems: 128 }),
  losses: Type.Optional(Type.Array(StCardImportLossV1Schema, { maxItems: 64 })),
});
export const ReviewStCardImportCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  reviewedFields: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
  approvedAtMs: Revision,
});
export const StCardImportReviewResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  importId: OpaqueHandle,
  reviewedFields: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
  approvedAtMs: Revision,
});
export const ConfirmStCardImportCommandV1Schema = strictObject({ apiVersion: ApiVersion });
/** The confirmed result is the same safe companion name projection as create. */
export const StCardImportConfirmResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  name: Type.String({ minLength: 1, maxLength: 128 }),
});
/**
 * Player-readable loss report per disposition class (design/28 Import/export
 * row): how many raw card fields the decoder kept or dropped, by class.
 */
export const StCardImportDispositionCountsV1Schema = strictObject({
  accepted_typed: Revision,
  preserved_opaque: Revision,
  dropped_unsupported: Revision,
  rejected_invalid: Revision,
});
/**
 * One durable evidence row for a confirmed import: when, which card it came
 * from, and what it kept or dropped by class. It carries no card body text and
 * grants no capability — it can never change what an import did.
 */
export const StCardImportHistoryEntryV1Schema = strictObject({
  importId: OpaqueHandle,
  occurredAtMs: Revision,
  cardName: Type.String({ minLength: 1, maxLength: 128 }),
  counts: StCardImportDispositionCountsV1Schema,
});
export const StCardImportHistoryV1Schema = strictObject({
  apiVersion: ApiVersion,
  entries: Type.Array(StCardImportHistoryEntryV1Schema, {}),
});

/**
 * Player-facing connection and model catalog (design/28 §1, §5.1).
 *
 * `setupFields` is the Host-defined allowlist of player-fillable fields; it is
 * a closed union with no free-form script, header, arbitrary URL or provider
 * payload field. `allowedPlayerModels` is curated guidance the panel marks as
 * suggestions, NOT the set of models the browser may select: every entry the
 * player configures declares `modelId`, so a player can type any bounded model
 * id, and the connection's own `modelIds` (what its endpoint listed at the last
 * probe) is what the panel offers beside those suggestions. The escape-hatch
 * entry additionally declares `baseUrl` and `apiShape`, the two facts about an
 * endpoint the Host cannot know.
 */
export const TavernConnectionSetupFieldV1Schema = Type.Union([
  Type.Literal("apiKey"),
  Type.Literal("apiShape"),
  Type.Literal("baseUrl"),
  Type.Literal("modelId"),
  // The endpoint's own credential requirement, stated by the player. A self-hosted server (Ollama,
  // LM Studio, vLLM) needs no credential at all, while an OpenAI-compatible gateway does, and only
  // the player knows which they pointed at - so it is a fact they state rather than a Host guess.
  // The curated public providers never declare it: their key requirement is not the player's to
  // relax, and `apiKeyRequired` absent therefore means "a credential is required".
  Type.Literal("apiKeyRequired"),
]);
/**
 * The exact `api` shapes the assistant runtime can speak.
 *
 * This is a wire mirror, like every other closed union in this file: the single
 * authority is `TAVERN_PI_API_SHAPES` in `tavern/provider-catalog.ts`, which
 * mirrors Pi's own chat provider adapters, and the Host test suite pins the two
 * together. The contract stays dependency-free on purpose — the browser client
 * loads this module directly.
 *
 * The escape hatch is the one entry whose player record chooses one of these,
 * and the chosen value is written verbatim into Pi's provider entry, so a shape
 * Pi cannot speak must never be admitted here.
 */
export const TavernConnectionApiShapeV1Schema = Type.Union([
  Type.Literal("anthropic-messages"),
  Type.Literal("azure-openai-responses"),
  Type.Literal("openai-completions"),
  Type.Literal("openai-responses"),
  Type.Literal("openai-codex-responses"),
  Type.Literal("google-generative-ai"),
  Type.Literal("google-vertex"),
  Type.Literal("bedrock-converse-stream"),
  Type.Literal("mistral-conversations"),
  Type.Literal("pi-messages"),
]);
/**
 * The thinking levels the embedded runtime accepts, in pi's own order.
 *
 * The authority is pi's `VALID_THINKING_LEVELS` (pi-coding-agent/dist/cli/args.js); a
 * level outside this set is not a preference the runtime can express. The union is
 * spelled out here rather than imported because this contract must stay
 * dependency-free: a dialogue-web test loads this module directly under Node.
 */
export const TavernConnectionThinkingLevelV1Schema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
]);
export const TavernConnectionModelV1Schema = strictObject({
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
  modelLabel: Type.String({ minLength: 1, maxLength: 128 }),
  allowedThinkingLevels: Type.Array(TavernConnectionThinkingLevelV1Schema, { maxItems: 7 }),
  defaultThinkingLevel: TavernConnectionThinkingLevelV1Schema,
});
/**
 * Ceiling on how many model ids one endpoint's own `/models` listing may contribute to a
 * connection projection. It is the ceiling `allowedPlayerModels` below already publishes for the
 * models one provider may be offered - the endpoint's own listing is offered the same way, so it
 * is bounded the same way - and it lives here once so the probe's cut and the wire's `maxItems`
 * cannot disagree. The probe verifies a selected model against the endpoint's WHOLE listing; only
 * this published projection is cut.
 */
export const TAVERN_MODEL_LISTING_LIMIT = 32;
/**
 * One model id the endpoint itself listed. The bound and the charset are the model id ceiling this
 * contract already enforces, so the listing cannot publish an id this product would refuse.
 */
const ListedModelId = Type.String({ minLength: 1, maxLength: MODEL_ID_MAX_LENGTH, pattern: MODEL_ID_PATTERN });
export const TavernConnectionProviderV1Schema = strictObject({
  providerId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
  label: Type.String({ minLength: 1, maxLength: 128 }),
  setupFields: Type.Array(TavernConnectionSetupFieldV1Schema, { maxItems: 5 }),
  /** Curated guidance the panel offers as suggestions; never the set of ids a player may type. */
  allowedPlayerModels: Type.Array(TavernConnectionModelV1Schema, { maxItems: TAVERN_MODEL_LISTING_LIMIT }),
  /** True only for the one OpenAI-compatible escape hatch (design/28 §1). */
  escapeHatch: Type.Boolean(),
  /** True when this provider is served by an operator environment credential. */
  environmentManaged: Type.Boolean(),
});
/** Closed, audit-safe probe category. Never raw provider status, header or body. */
const ConnectionFailure = Type.Union([
  Type.Literal("invalid_endpoint"),
  Type.Literal("not_configured"),
  Type.Literal("unauthorized"),
  Type.Literal("not_found"),
  Type.Literal("unreachable"),
  Type.Literal("timeout"),
  Type.Literal("invalid_response"),
  Type.Null(),
]);
/**
 * One player-readable connection row (design/28 §5.1). `connectionId` is an
 * opaque write handle and is never the player's result, so the row also
 * carries the labels a player actually reads. `baseUrl` is the player's own
 * submitted endpoint — the one endpoint fact they may read back (§1) — and is
 * null for every catalog endpoint they did not type.
 */
export const TavernConnectionV1Schema = strictObject({
  connectionId: OpaqueHandle,
  label: Type.String({ minLength: 1, maxLength: 256 }),
  providerId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
  providerLabel: Type.String({ minLength: 1, maxLength: 128 }),
  configured: Type.Boolean(),
  readiness: Type.Union([
    Type.Literal("unconfigured"),
    Type.Literal("configured"),
    Type.Literal("ready"),
    Type.Literal("failed"),
  ]),
  active: Type.Boolean(),
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
  modelLabel: Type.String({ minLength: 1, maxLength: 128 }),
  thinkingLevel: TavernConnectionThinkingLevelV1Schema,
  // What this record's model accepts. The panel offers exactly these, because the
  // Host refuses a level the model does not advertise.
  allowedThinkingLevels: Type.Array(TavernConnectionThinkingLevelV1Schema, { maxItems: 7 }),
  /**
   * The endpoint's own model listing as of this record's last probe, or null when that probe read
   * none. It is what the endpoint served at that moment (bounded by `TAVERN_MODEL_LISTING_LIMIT`
   * and sanitised to ids this product accepts), never a claim about which of them will answer.
   */
  modelIds: Type.Union([Type.Array(ListedModelId, { maxItems: TAVERN_MODEL_LISTING_LIMIT }), Type.Null()]),
  baseUrl: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  failure: ConnectionFailure,
  lastCheckedAtMs: Type.Union([Revision, Type.Null()]),
});
/** The one active selection (design/28 §5.1), or null while none is active. */
export const TavernConnectionActiveV1Schema = strictObject({
  connectionId: OpaqueHandle,
  label: Type.String({ minLength: 1, maxLength: 256 }),
  providerLabel: Type.String({ minLength: 1, maxLength: 128 }),
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
  modelLabel: Type.String({ minLength: 1, maxLength: 128 }),
  thinkingLevel: TavernConnectionThinkingLevelV1Schema,
  readiness: Type.Union([
    Type.Literal("unconfigured"),
    Type.Literal("configured"),
    Type.Literal("ready"),
    Type.Literal("failed"),
  ]),
  baseUrl: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
  failure: ConnectionFailure,
  lastCheckedAtMs: Type.Union([Revision, Type.Null()]),
});
/**
 * `GET /settings/connection` (design/28 §5.1). `revision` is the durable
 * document revision every mutation carries as its compare-and-swap, because a
 * stale tab must get a conflict instead of silently overwriting a newer
 * selection.
 */
export const TavernConnectionStateV1Schema = strictObject({
  apiVersion: ApiVersion,
  revision: Revision,
  active: Type.Union([TavernConnectionActiveV1Schema, Type.Null()]),
  connections: Type.Array(TavernConnectionV1Schema, { maxItems: 16 }),
  providers: Type.Array(TavernConnectionProviderV1Schema, { maxItems: 16 }),
});
export const TavernConnectionReadV1Schema = TavernConnectionStateV1Schema;
export const TavernConnectionCreateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  providerId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
  /** Write-only. Never echoed, projected, logged or read back by any route. */
  apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  /** The escape hatch's player-supplied endpoint. A query string is admitted there. */
  baseUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  /** The escape hatch's player-supplied API shape, from the runtime's own set. */
  apiShape: Type.Optional(TavernConnectionApiShapeV1Schema),
  modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  /**
   * The player's answer to whether this endpoint needs a credential. Only an entry that declares
   * `apiKeyRequired` may receive it, and only `false` admits a record with no key (`apiKey` absent).
   * Absent means a credential is required, which is what every curated provider needs.
   */
  apiKeyRequired: Type.Optional(Type.Boolean()),
});
export const TavernConnectionRevisionCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Revision,
});
export const TavernConnectionModelCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Revision,
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
  thinkingLevel: TavernConnectionThinkingLevelV1Schema,
});
/** The probe read-back: one closed outcome plus the resulting projection. */
export const TavernConnectionProbeV1Schema = strictObject({
  apiVersion: ApiVersion,
  connectionId: OpaqueHandle,
  outcome: Type.Union([Type.Literal("ready"), Type.Literal("failed")]),
  failure: ConnectionFailure,
  state: TavernConnectionStateV1Schema,
});
/**
 * One shipped catalog model offered as guidance for a player-typed model id
 * (design/28 §2.3.2). It is a suggestion the UI may show; the model profile
 * accepts any bounded model id, so this list is never the upper bound.
 */
export const TavernRecommendedModelV1Schema = strictObject({
  providerId: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
  providerLabel: Type.String({ minLength: 1, maxLength: 128 }),
  modelId: Type.String({ minLength: 1, maxLength: 128 }),
  modelLabel: Type.String({ minLength: 1, maxLength: 128 }),
  allowedThinkingLevels: Type.Array(TavernConnectionThinkingLevelV1Schema, { maxItems: 7 }),
  defaultThinkingLevel: TavernConnectionThinkingLevelV1Schema,
});
/**
 * One surface's active model profile (design/28 §2.3): the thinking level that surface
 * reasons at, and nothing else.
 *
 * The model and the provider are not here, and that is deliberate: this product ships no
 * endpoint, so the player's own active connection is the one thing that names a provider, a
 * model and an endpoint together. A profile carrying a model id would be a second spelling of
 * that choice, able to name a model no connection serves.
 */
export const TavernModelProfileV1Schema = strictObject({
  revision: Revision,
  thinkingLevel: Type.String({ minLength: 1, maxLength: 32, pattern: THINKING_LEVEL_PATTERN }),
});
/** `GET /settings/profiles`: the Chat and Game profiles plus the guidance catalog. */
export const TavernModelProfilesV1Schema = strictObject({
  apiVersion: ApiVersion,
  chat: TavernModelProfileV1Schema,
  game: TavernModelProfileV1Schema,
  recommendedModels: Type.Array(TavernRecommendedModelV1Schema, { maxItems: 64 }),
});
export const TavernModelProfileUpdateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  surface: Type.Union([Type.Literal("chat"), Type.Literal("game")]),
  expectedRevision: Revision,
  thinkingLevel: Type.String({ minLength: 1, maxLength: 32, pattern: THINKING_LEVEL_PATTERN }),
});
const OperationId = Type.Union([
  Type.Literal("chat.submit"),
  Type.Literal("chat.cancel"),
  // The new-chat opening variant choice: commits variant N of the mounted companion's greeting
  // set as the empty Chat's message zero, reusing `ChatThreadStore.commitOpening`.
  Type.Literal("chat.opening"),
  // New Chat: creates a second conversation in the mounted companion/continuity.
  Type.Literal("chat.create"),
  // Chat selection: chooses which existing Chat the mounted conversation shows, in process when
  // it is idle and at the next start when a turn is in flight.
  Type.Literal("chat.select"),
  Type.Literal("chat.archive"),
  Type.Literal("chat.restore"),
  Type.Literal("chat.trash"),
  Type.Literal("character.voice.read"),
  Type.Literal("character.voice.update"),
  Type.Literal("draft.save"),
  Type.Literal("draft.discard"),
  Type.Literal("chat.rename"),
  Type.Literal("memory.mutate"),
  Type.Literal("world-info.bind"),
  Type.Literal("world-info.detail"),
  Type.Literal("world-info.create"),
  Type.Literal("world-info.update"),
  Type.Literal("world-info.delete"),
  Type.Literal("companion.list"),
  Type.Literal("companion.worldbook.read"),
  // The player rewrites her companion's own book: the complete entry list, CASed on the
  // revision the read projected.
  Type.Literal("companion.worldbook.update"),
  // The read-only character inspector: one companion's own authored facts, by
  // the roster's own opaque handle.
  Type.Literal("companion.profile.read"),
  // Export one roster companion's own records as a standard Tavern V2/V3 character
  // card: the same handle addressing as the inspector, because the whole point is to
  // take her work out of the product.
  Type.Literal("companion.card.export"),
  // Give one roster companion a picture, addressed by the same handle the roster
  // projected - any listed companion, whoever she is, because the roster and the
  // inspector show every companion and a hand-made one should stop being a monogram
  // by the player's own choice.
  Type.Literal("companion.avatar.update"),
  // Remove one roster companion for good: her record and her artifact root, by the
  // roster's own handle and the revision she was read at. The companion in play is
  // refused by name - her conversations are the mounted ones.
  Type.Literal("companion.delete"),
  Type.Literal("companion.create"),
  Type.Literal("character.import.stage"),
  Type.Literal("character.import.read"),
  Type.Literal("character.import.review"),
  Type.Literal("character.import.confirm"),
  Type.Literal("character.import.history"),
  Type.Literal("persona.read"),
  Type.Literal("persona.update"),
  Type.Literal("scenario.read"),
  Type.Literal("scenario.update"),
  Type.Literal("greeting.read"),
  Type.Literal("greeting.update"),
  Type.Literal("settings.voice.read"),
  Type.Literal("settings.voice.consent"),
  Type.Literal("settings.voice.devices"),
  Type.Literal("settings.language.read"),
  Type.Literal("settings.language.update"),
  Type.Literal("settings.delivery.read"),
  Type.Literal("settings.delivery.update"),
  // The player's own addition to the Game companion's starting instructions. It is a
  // settings write like language and delivery, but it lands in a RUNNING SESSION's
  // prompt only at the next start: the addition is read once when a Game session is
  // constructed, so a running game keeps the text it started with.
  Type.Literal("settings.game-prompt.read"),
  Type.Literal("settings.game-prompt.update"),
  Type.Literal("settings.connection.read"),
  Type.Literal("settings.connection.create"),
  Type.Literal("settings.connection.test"),
  Type.Literal("settings.connection.activate"),
  Type.Literal("settings.connection.model"),
  Type.Literal("settings.connection.remove"),
  Type.Literal("settings.profiles.read"),
  Type.Literal("settings.profiles.update"),
]);
const LabelKey = Type.Union([
  Type.Literal("tavern.nav.chat"),
  Type.Literal("tavern.nav.memory"),
  Type.Literal("tavern.nav.characters"),
  Type.Literal("tavern.operation.submit"),
  Type.Literal("tavern.operation.cancel"),
  Type.Literal("tavern.operation.chat.opening"),
  Type.Literal("tavern.operation.chat.create"),
  Type.Literal("tavern.operation.chat.select"),
  Type.Literal("tavern.operation.draft.save"),
  Type.Literal("tavern.operation.draft.discard"),
  Type.Literal("tavern.operation.rename"),
  Type.Literal("tavern.operation.memory.mutate"),
  Type.Literal("tavern.operation.world-info.bind"),
  Type.Literal("tavern.operation.world-info.detail"),
  Type.Literal("tavern.operation.world-info.create"),
  Type.Literal("tavern.operation.world-info.update"),
  Type.Literal("tavern.operation.world-info.delete"),
  Type.Literal("tavern.operation.chat.archive"),
  Type.Literal("tavern.operation.chat.restore"),
  Type.Literal("tavern.operation.chat.trash"),
  Type.Literal("tavern.operation.character.voice.read"),
  Type.Literal("tavern.operation.character.voice.update"),
  Type.Literal("tavern.operation.companion.list"),
  Type.Literal("tavern.operation.companion.worldbook.read"),
  Type.Literal("tavern.operation.companion.worldbook.update"),
  Type.Literal("tavern.operation.companion.profile.read"),
  Type.Literal("tavern.operation.companion.card.export"),
  Type.Literal("tavern.operation.companion.avatar.update"),
  Type.Literal("tavern.operation.companion.delete"),
  Type.Literal("tavern.operation.companion.create"),
  Type.Literal("tavern.operation.character.import.stage"),
  Type.Literal("tavern.operation.character.import.read"),
  Type.Literal("tavern.operation.character.import.review"),
  Type.Literal("tavern.operation.character.import.confirm"),
  Type.Literal("tavern.operation.character.import.history"),
  Type.Literal("tavern.operation.persona.read"),
  Type.Literal("tavern.operation.persona.update"),
  Type.Literal("tavern.operation.scenario.read"),
  Type.Literal("tavern.operation.scenario.update"),
  Type.Literal("tavern.operation.greeting.read"),
  Type.Literal("tavern.operation.greeting.update"),
  Type.Literal("tavern.operation.settings.voice.read"),
  Type.Literal("tavern.operation.settings.voice.consent"),
  Type.Literal("tavern.operation.settings.voice.devices"),
  Type.Literal("tavern.operation.settings.language.read"),
  Type.Literal("tavern.operation.settings.language.update"),
  Type.Literal("tavern.operation.settings.delivery.read"),
  Type.Literal("tavern.operation.settings.delivery.update"),
  Type.Literal("tavern.operation.settings.game-prompt.read"),
  Type.Literal("tavern.operation.settings.game-prompt.update"),
  Type.Literal("tavern.operation.settings.connection.read"),
  Type.Literal("tavern.operation.settings.connection.create"),
  Type.Literal("tavern.operation.settings.connection.test"),
  Type.Literal("tavern.operation.settings.connection.activate"),
  Type.Literal("tavern.operation.settings.connection.model"),
  Type.Literal("tavern.operation.settings.connection.remove"),
  Type.Literal("tavern.operation.settings.profiles.read"),
  Type.Literal("tavern.operation.settings.profiles.update"),
]);
export const TavernBrowserOperationV1Schema = strictObject({
  operationId: OperationId,
  labelKey: LabelKey,
  availability: Type.Union([Type.Literal("available"), Type.Literal("busy"), Type.Literal("unavailable")]),
  routeId: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9._-]*$" }),
});
const NavigationItemId = Type.Union([Type.Literal("chat"), Type.Literal("memory"), Type.Literal("characters")]);
const NavigationItem = strictObject({
  itemId: NavigationItemId,
  labelKey: LabelKey,
  availability: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
});
const WorldInfoBindingState = Type.Union([
  Type.Literal("none"),
  Type.Literal("selected"),
  Type.Literal("pending"),
  Type.Literal("unavailable"),
]);
/**
 * Safe World Info binding projection for the exact mounted Chat. `revision`
 * and every item `handle` are opaque values minted by the Host binding
 * service; the browser can never decode them into a durable fact.
 *
 * `items` carries no count cap: the managed library's own writer bounds the catalog
 * (`world-info-management.ts`, `MAX_ARTIFACTS`), and a contract cap below that writer
 * would turn its legally-held excess into a refused whole-read, exactly the 100-Chat
 * defect. A library that legitimately holds 128 items must project all of them.
 */
export const WorldInfoStateV1Schema = strictObject({
  state: WorldInfoBindingState,
  revision: OpaqueHandle,
  items: Type.Array(
    strictObject({
      handle: OpaqueHandle,
      title: Type.String({ minLength: 1, maxLength: 256 }),
      summary: Type.Union([Type.String({ maxLength: 512 }), Type.Null()]),
      selected: Type.Boolean(),
      pending: Type.Boolean(),
    }),
  ),
});
/**
 * Exact bind/unbind command. `expectedRevision` and `sourceHandle` are the
 * opaque handles from the last validated state projection; a raw title,
 * timestamp, storage handle or canonical hash is never expressible here.
 */
export const SetWorldInfoBindingCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: OpaqueHandle,
  sourceHandle: Type.Union([OpaqueHandle, Type.Null()]),
});
/**
 * One authored entry of a managed World Info item. `scope`, the entry's own trigger words and the
 * always-on flag are the entry's facts; nothing durable about the library (storage handle, path,
 * canonical hash) is expressible here.
 */
export const WorldInfoEntryV1Schema = strictObject({
  scope: Type.Union([Type.Literal("companion"), Type.Literal("setting")]),
  publicTitle: Type.String({ minLength: 1, maxLength: 128 }),
  summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  keys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 128 })),
  secondaryKeys: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { minItems: 1, maxItems: 128 }),
  ),
  selectiveLogic: Type.Optional(Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)])),
  constant: Type.Optional(Type.Boolean()),
});
/**
 * One library item's own content at one exact revision: what `world-info.detail` returns and what
 * `world-info.create`/`update` carry. `revision` is the library's own optimistic revision - an
 * integer the library mints - because an edit CASes on it directly; the opaque projection handle
 * that guards *which* library the browser is looking at travels separately, on the command.
 *
 * `entries` is deliberately uncapped. The managed store bounds an item by its own revision
 * envelope, and a smaller contract cap would refuse an artifact the library legitimately holds -
 * the same reason `MemoryReadV1.memories` carries no cap.
 */
export const WorldInfoItemV1Schema = strictObject({
  revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  publicTitle: Type.String({ minLength: 1, maxLength: 128 }),
  summary: Type.String({ minLength: 1, maxLength: 4_000 }),
  entries: Type.Array(WorldInfoEntryV1Schema),
});
/**
 * `world-info.detail`'s addressing command: the exact opaque library projection the browser last
 * read, plus one item's opaque handle inside it. A raw title, a storage revision number or a
 * handle from any other projection is never expressible.
 */
export const WorldInfoItemCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: OpaqueHandle,
  itemHandle: OpaqueHandle,
});
/**
 * `world-info.create`: the new item's content, addressed in the exact opaque projection the browser
 * read. The library refuses a title an item already carries and reports `world_info_already_exists`.
 */
export const WorldInfoCreateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: OpaqueHandle,
  item: strictObject({
    publicTitle: Type.String({ minLength: 1, maxLength: 128 }),
    summary: Type.String({ minLength: 1, maxLength: 4_000 }),
    entries: Type.Array(WorldInfoEntryV1Schema),
  }),
});
/**
 * `world-info.update`: one item's new content. The top-level `expectedRevision` is the opaque
 * projection handle; `item.expectedRevision` is the library's own revision the edit CASes on, so a
 * stale edit is refused with `world_info_revision_conflict` rather than overwriting a newer one.
 */
export const WorldInfoUpdateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: OpaqueHandle,
  itemHandle: OpaqueHandle,
  item: strictObject({
    publicTitle: Type.String({ minLength: 1, maxLength: 128 }),
    summary: Type.String({ minLength: 1, maxLength: 4_000 }),
    entries: Type.Array(WorldInfoEntryV1Schema),
    expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  }),
});
/**
 * `world-info.import`: one external SillyTavern/Chub lorebook file, carried whole.
 *
 * The file is the player's own artifact, so its interior is the importer's business, not this
 * contract's: `lorebook` admits any JSON object and the managed library's one importer
 * (`tavern-lorebook-importer.ts`) decides what each entry becomes. Writing that translation a
 * second time as a wire schema is exactly what left this capability with no player path - the
 * authored `world-info.create` shape refuses every real lorebook file, so the importer could only
 * be reached from a test.
 */
export const WorldInfoImportCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: OpaqueHandle,
  lorebook: Type.Object({}, { additionalProperties: true }),
});
/**
 * The import route's request-body ceiling. A lorebook is one JSON file, so the card JSON input
 * ceiling (`ST_CARD_DECODER_LIMITS_V1.inputBytesJson`, 2 MiB) is the right magnitude - a bound that
 * refuses every real lorebook (the dispatcher's generic 24 KiB body) makes the route a dead end,
 * and one with no bound is not a contract. The margin covers the JSON envelope's field names; the
 * file's own content is bounded by the strict JSON reader behind the importer.
 */
export const MAX_WORLD_INFO_IMPORT_BODY_BYTES = ST_CARD_DECODER_LIMITS_V1.inputBytesJson + 8_192;

/**
 * Companion library entry: opaque handle plus display metadata only. No
 * identity, continuity, profile, hash, path or runtime fact is expressible.
 */
export const CompanionListEntryV1Schema = strictObject({
  handle: OpaqueHandle,
  name: Type.String({ minLength: 1, maxLength: 128 }),
  isCurrent: Type.Boolean(),
});
export const CompanionListV1Schema = strictObject({
  apiVersion: ApiVersion,
  // No count cap: the library enumerates every extant companion artifact
  // (`library-service.ts listCompanions`), so a cap here would blank the whole
  // Characters read the moment a player's 101st card was imported.
  companions: Type.Array(CompanionListEntryV1Schema),
});
/** Safe player-visible companion detail: name only (companion-detail boundary). */
export const CompanionDetailV1Schema = strictObject({
  apiVersion: ApiVersion,
  name: Type.String({ minLength: 1, maxLength: 128 }),
});
/**
 * The longest rendered entry body the browser may read, in UTF-16 code units. It is
 * the same order as the other authored-text bounds on this contract and exists so a
 * pathological entry cannot make the surface unreadable; a body over it is refused
 * with a named code rather than truncated, because a silently shortened entry would
 * read as the author's text.
 */
export const COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH = 4_096;

/**
 * One entry of the companion's own durable world book (`<runtimeCwd>/worldbook.json`),
 * as the reviewed card import persisted it.
 *
 * The entry's body IS projected, read-only, for the player. It used to say the
 * opposite - "deliberately NOT projected: the worldbook tools already omit bodies
 * from their catalog, and a body is context the companion reads rather than text
 * the browser renders" - and that reasoning did not survive the surface it sits
 * on: the same panel lets the player read and edit this companion's voice
 * directive, persona, scenario and greetings, and the card's own text was already
 * shown to them at import review. Seeing a trigger word but not the text it
 * triggers is the defect that reasoning left in place. `keys` remain the card's
 * own trigger words, and per-turn selection matches them against what the player
 * actually said, so between them the player can now see both what an entry says
 * and which of their own words reaches it. `constant` marks the always-on
 * background, which is carried whatever is said and therefore carries no trigger
 * words.
 *
 * The body is projected already rendered through the run's macro table
 * (`desktop-presentation-admission-owner.ts`, the same authority the scenario
 * projection uses), so a `{{user}}`/`{{char}}` placeholder never reaches the
 * player - and the durable file keeps the author's own text. **Editing** an entry
 * is served by `companion.worldbook.update`, which carries this shape back with
 * the book's durable revision as the CAS. The rendered body is what the player
 * read and what she edits, so the write path keeps each row's durable authored
 * text whenever that row still renders to exactly what came back, and keeps the
 * row bound to the entry it came from - by title, or failing that by its own
 * body - so an edit to what it SAYS never resets when it fires.
 */
export const CompanionWorldBookEntryV1Schema = strictObject({
  title: Type.String({ minLength: 1, maxLength: 256 }),
  keys: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 16 }),
  constant: Type.Boolean(),
  /**
   * The entry's own text, as the Host rendered it: macros resolved, bounded.
   *
   * It belongs in this schema because the dispatcher validates every reply
   * against it before the browser sees one (`tavern-management-dialogue-web.ts`
   * checks `CompanionWorldBookV1Schema`), so a service that projects a field the
   * published schema does not declare fails closed with
   * `companion_record_unreadable` - which is what happened when the body was
   * first projected here: the projection carried it, the schema did not, and the
   * route answered 503 for every read.
   */
  content: Type.String({ maxLength: COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH }),
});
/**
 * The companion's own world book. This is a DIFFERENT thing from the World Info
 * items a conversation can attach (`world-info.read`): that list is the managed
 * library of artifacts a Chat may bind, and this is the book the companion was
 * provisioned with. Conflating the two is what let a surface that reads the
 * library claim to be showing the character's own book.
 *
 * `present` is false when the companion has no book at all. The surface renders no
 * block in that case rather than an empty one, so a companion without a book never
 * reads as a book whose entries were lost.
 *
 * `revision` is the durable book's own revision from `<runtimeCwd>/worldbook.json`,
 * and it is null in exactly the one case `present` is false: a book that exists
 * always carries a positive revision. It is projected because an edit must CAS on
 * it - the file is replaced whole, so without the value the browser read, two edits
 * would silently overwrite one another and the second screen would be showing a book
 * that no longer exists.
 */
export const CompanionWorldBookV1Schema = strictObject({
  apiVersion: ApiVersion,
  present: Type.Boolean(),
  revision: Type.Union([Revision, Type.Null()]),
  entries: Type.Array(CompanionWorldBookEntryV1Schema, { maxItems: 128 }),
});
/**
 * One player edit of the companion's OWN world book: the complete entry list as the
 * player now wants her book to read, CASed on the revision she read.
 *
 * The whole list is replaced rather than one row named by an id, because the durable
 * `entryId` is a storage fact the browser is never handed: the projection carries
 * titles, trigger words and bodies, and the list that comes back IS the book the
 * player wants. The book's premise and its declared scan depth are not projected, so
 * they are not editable here and the write path carries them through unchanged - a
 * mutation that is not about them must not silently drop them.
 *
 * An inbound entry is the projection's own entry shape (its body is the RENDERED
 * text the player read), so this command can never carry a bound the read does not
 * already carry.
 */
export const UpdateCompanionWorldBookCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  entries: Type.Array(CompanionWorldBookEntryV1Schema, { maxItems: 128 }),
});
/**
 * The longest authored profile text the browser may read, in UTF-16 code units.
 *
 * It is the same authored-text bound the neighbouring schema projections carry
 * (`ScenarioV1Schema`, `GreetingV1Schema`, `CompanionCharacterVoiceV1Schema`),
 * and it exists in the same shape as `COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH`:
 * a field that renders past it is refused with a named code rather than
 * truncated, because a silently shortened field would read as the author's text.
 */
export const COMPANION_PROFILE_TEXT_MAX_LENGTH = 8_192;
/**
 * The longest single-line profile label: a name, a set label, a variant label.
 * It is the identity profile's own name bound, copied here because this module
 * stays dependency-free (the browser client loads it directly).
 */
export const COMPANION_PROFILE_NAME_MAX_LENGTH = 128;

/**
 * The companion's own authored persona, as the identity profile holds it.
 *
 * `present` separates the two facts the inspector must never conflate: she was
 * provisioned without a persona at all, or she has one and a given dimension of
 * it is empty. Each dimension is orthogonal (who she is / how she treats the
 * player / her tone), so a card that wrote only one carries only that one.
 */
const CompanionProfilePersonaV1Schema = strictObject({
  present: Type.Boolean(),
  core: Type.Union([
    Type.String({
      minLength: 1,
      maxLength: COMPANION_PROFILE_TEXT_MAX_LENGTH,
      format: "tavern-browser-nfc-utf8-text-v1",
    }),
    Type.Null(),
  ]),
  interactionStyle: Type.Union([
    Type.String({
      minLength: 1,
      maxLength: COMPANION_PROFILE_TEXT_MAX_LENGTH,
      format: "tavern-browser-nfc-utf8-text-v1",
    }),
    Type.Null(),
  ]),
  expressionStyle: Type.Union([
    Type.String({
      minLength: 1,
      maxLength: COMPANION_PROFILE_TEXT_MAX_LENGTH,
      format: "tavern-browser-nfc-utf8-text-v1",
    }),
    Type.Null(),
  ]),
});
/**
 * The companion's own scenario, as the reviewed card wrote it at provisioning.
 * `present: false` is "she was made without one"; both fields are null in that
 * case, so an absent scenario never reads as a scenario with empty text.
 */
const CompanionProfileScenarioV1Schema = strictObject({
  present: Type.Boolean(),
  name: Type.Union([Type.String({ minLength: 1, maxLength: COMPANION_PROFILE_NAME_MAX_LENGTH }), Type.Null()]),
  description: Type.Union([
    Type.String({
      minLength: 1,
      maxLength: COMPANION_PROFILE_TEXT_MAX_LENGTH,
      format: "tavern-browser-nfc-utf8-text-v1",
    }),
    Type.Null(),
  ]),
});
/**
 * One opening the companion can start a chat with. Its text is authored content
 * and reaches the player already rendered through the run's macro table, so a
 * `{{user}}`/`{{char}}` placeholder is never painted here; the durable record
 * keeps the author's own words.
 */
const CompanionProfileOpeningVariantV1Schema = strictObject({
  label: Type.Union([Type.String({ minLength: 1, maxLength: COMPANION_PROFILE_NAME_MAX_LENGTH }), Type.Null()]),
  text: Type.String({
    minLength: 1,
    maxLength: COMPANION_PROFILE_TEXT_MAX_LENGTH,
    format: "tavern-browser-nfc-utf8-text-v1",
  }),
});
/**
 * The companion's own greeting set, which a chat with her opens from.
 * `present: false` is "she was made without one" - there is no empty variant
 * list to confuse it with, because a greeting set always carries a variant.
 */
const CompanionProfileGreetingsV1Schema = strictObject({
  present: Type.Boolean(),
  label: Type.Union([Type.String({ minLength: 1, maxLength: COMPANION_PROFILE_NAME_MAX_LENGTH }), Type.Null()]),
  variants: Type.Array(CompanionProfileOpeningVariantV1Schema, { maxItems: 16 }),
});
/**
 * The read-only character inspector's projection: one companion's own authored
 * facts, addressed by the same opaque handle the roster projected.
 *
 * It is NOT the mounted editor's projection. `persona.read` is the PLAYER's
 * persona; `scenario.read`/`greeting.read` and the world-book read resolve only
 * the mounted companion. This is the one read that resolves any roster
 * companion and returns what SHE carries: her name, her persona, her scenario,
 * her openings and her own world book. It is read-only by construction - the
 * schema declares no command and no route serves a write - so the inspector can
 * never become a second, divergent place to edit a field another panel owns.
 *
 * `present` on each group is the fact the panel tells apart: "she was made
 * without one" versus "she has one and it is empty". Every authored string is
 * rendered through the run's macro table before it leaves the Host, exactly as
 * the scenario and world-book projections do.
 */
export const CompanionProfileV1Schema = strictObject({
  apiVersion: ApiVersion,
  name: Type.String({ minLength: 1, maxLength: COMPANION_PROFILE_NAME_MAX_LENGTH }),
  /**
   * The revision of her own `companion.json` record - the one `companion.delete` CASes on.
   *
   * It lives here rather than on the roster because this is the screen that owns the
   * delete control: the player reads her, then removes her, so the revision she was read
   * at is the one the removal must match. It is null in exactly one case - the mounted
   * companion spliced into the roster from the identity profile while her library record
   * could not be read - and she can never be deleted in any case, because she is the one
   * in play.
   */
  revision: Type.Union([Revision, Type.Null()]),
  persona: CompanionProfilePersonaV1Schema,
  scenario: CompanionProfileScenarioV1Schema,
  greetings: CompanionProfileGreetingsV1Schema,
  worldBook: CompanionWorldBookV1Schema,
});
/** The PNG card ceiling, base64-inflated - the decoder's own PNG input bound. */
const CARD_FILE_BASE64_MAX_CHARS = Math.ceil(ST_CARD_DECODER_LIMITS_V1.inputBytesPng / 3) * 4;
/**
 * One companion's own records exported as a standard Tavern V3 character card,
 * in the form the caller asked for.
 *
 * The JSON arm carries `card`, the card's own JSON TEXT - exactly the bytes the
 * browser saves - bounded by the decoder's own JSON input ceiling. The PNG arm
 * carries `cardFileBase64`, the WHOLE card file (her picture with the card inside
 * it) base64-encoded, bounded by the decoder's PNG input ceiling. Either way the
 * Host stays the one authority on how a card is built and the browser saves what
 * it was handed rather than re-serializing it. `fileName` is what the save dialog
 * offers, and `spec` is the card format's own declared version.
 *
 * `format` names which arm this is, so the browser never infers the file's kind
 * from anything as weak as an extension.
 */
export const CompanionCardExportV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    format: Type.Literal("json"),
    spec: Type.Literal("chara_card_v3"),
    fileName: Type.String({ minLength: 1, maxLength: 200 }),
    card: Type.String({ minLength: 2, maxLength: ST_CARD_DECODER_LIMITS_V1.inputBytesJson }),
  }),
  // The PNG form: her picture with the card inside it, as the WHOLE card file,
  // base64. `cardFileBase64` is the same spelling `character.import.stage` uses
  // for a PNG card on the way in, so one format has one name in both directions.
  strictObject({
    apiVersion: ApiVersion,
    format: Type.Literal("png"),
    spec: Type.Literal("chara_card_v3"),
    fileName: Type.String({ minLength: 1, maxLength: 200 }),
    cardFileBase64: Type.String({ minLength: 2, maxLength: CARD_FILE_BASE64_MAX_CHARS }),
  }),
]);
/**
 * `companion.avatar.update`: the player's own picture for one roster companion.
 *
 * The payload is the WHOLE picture, base64 - the same spelling `character.import.stage`
 * uses for a PNG card, because it is the same thing arriving the same way: bytes the
 * browser read from the player's own disk. `avatarBase64` is bounded by the avatar
 * module's own ceiling, base64-inflated (`ceil(N/3)*4`), and that ceiling is the card
 * decoder's own `inputBytesPng` - the avatar IS the card's picture, so the number that
 * bounds an importable card is the number that bounds its picture. This module cannot
 * import that one (`host/src/tavern/companion-avatar/index.ts` reaches `node:fs`), so
 * `browser-contract/index.test.ts` holds `MAX_COMPANION_AVATAR_BYTES` and this bound to
 * the same number.
 *
 * The bound is enforced twice before any picture is written: the transport reads at most
 * `MAX_COMPANION_AVATAR_UPLOAD_BODY_BYTES`, and this schema refuses an encoded string
 * longer than a whole-ceiling picture encodes to. Neither is a check on a body that was
 * already buffered without a limit.
 */
export const MAX_COMPANION_AVATAR_BASE64_CHARS = Math.ceil(ST_CARD_DECODER_LIMITS_V1.inputBytesPng / 3) * 4;
/** The avatar upload's whole request ceiling: an at-ceiling base64 picture plus its JSON envelope. */
export const MAX_COMPANION_AVATAR_UPLOAD_BODY_BYTES = MAX_COMPANION_AVATAR_BASE64_CHARS + 8_192;
export const CompanionAvatarUploadCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  avatarBase64: Type.String({ minLength: 1, maxLength: MAX_COMPANION_AVATAR_BASE64_CHARS }),
});
/**
 * The read-back of one stored picture: which companion it belongs to, and the digest of
 * the bytes now on disk.
 *
 * The digest is the fact both directions share: it is the `ETag` the runtime asset face
 * publishes for `/assets/companions/<handle>/avatar.png`, so a browser holding the
 * previous picture revalidates against the same value an upload answered with, and "she
 * has a new picture" is never something the client has to guess. There is deliberately
 * no `expectedRevision`: a picture is not a conflict-prone document, so a replacement is
 * unconditional and this digest is the honest record of what replaced what.
 */
export const CompanionAvatarV1Schema = strictObject({
  apiVersion: ApiVersion,
  handle: OpaqueHandle,
  digest: Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
});
/**
 * `companion.delete`: remove one roster companion for good.
 *
 * Two things are named and nothing else: the opaque handle the roster projected
 * (`companion.list`), and the revision of her own `companion.json` record that the
 * roster read carried. The revision is a compare-and-set, not a version to bump: a
 * delete armed against a record that has moved on is refused, so the player never
 * destroys a companion from a screen that was showing a stale copy of her.
 *
 * The handle is the ONLY companion identity the request can name - a `companionId`, a
 * continuity, a path or a title is not expressible, exactly like the inspector, the card
 * export and the avatar upload.
 */
export const DeleteCompanionCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Revision,
});
/**
 * What a completed `companion.delete` answers: the handle that no longer resolves, so the
 * surface can say which row went and drop exactly it.
 *
 * There is no revision to answer with and none to keep: the record is gone, and a
 * tombstone would be a second authority claiming she existed.
 */
export const CompanionDeletionV1Schema = strictObject({
  apiVersion: ApiVersion,
  handle: OpaqueHandle,
});
/**
 * The mounted companion's own performance directive, as the durable identity
 * profile holds it (the imported card's `system_prompt`).
 *
 * `source` is provenance for the review surface: `card` while the text is
 * exactly what the imported card supplied, `player` once the player has edited
 * it. The member is absent (projected as null) when the card wrote none or the
 * player cleared it, so a cleared field reads as absent rather than as empty
 * text - the same shape the prompt renders.
 */
export const CompanionCharacterVoiceV1Schema = strictObject({
  text: Type.String({ minLength: 1, maxLength: 8_192, format: "tavern-browser-nfc-utf8-text-v1" }),
  source: Type.Union([Type.Literal("card"), Type.Literal("player")]),
});
/**
 * The companion voice read-back: the durable profile revision the browser must
 * CAS against plus the effective directive (null when absent).
 */
export const CompanionVoiceV1Schema = strictObject({
  apiVersion: ApiVersion,
  profileRevision: Revision,
  characterVoice: Type.Union([CompanionCharacterVoiceV1Schema, Type.Null()]),
});
/**
 * One edit or one clear of the mounted companion's performance directive. An
 * edit always re-authors the text as the player's (`source: "player"`); a clear
 * removes the field entirely rather than storing empty text.
 */
export const UpdateCompanionVoiceCommandV1Schema = Type.Union([
  strictObject({
    apiVersion: ApiVersion,
    expectedProfileRevision: Revision,
    text: Type.String({ minLength: 1, maxLength: 8_192, format: "tavern-browser-nfc-utf8-text-v1" }),
  }),
  strictObject({
    apiVersion: ApiVersion,
    expectedProfileRevision: Revision,
    clear: Type.Literal(true),
  }),
]);
/** Create companion from a player-supplied display name; Host mints all IDs. */
export const CreateCompanionCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  name: Type.String({ minLength: 1, maxLength: 128 }),
});
/** Player persona projection: revision and safe display fields only. */
export const PersonaV1Schema = strictObject({
  apiVersion: ApiVersion,
  present: Type.Boolean(),
  revision: Type.Union([Revision, Type.Null()]),
  name: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  description: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
});
export const PersonaUpdateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Type.Union([Revision, Type.Literal(0)]),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
});
/** Player scenario projection: safe display fields plus a bounded preview. */
export const ScenarioV1Schema = strictObject({
  apiVersion: ApiVersion,
  present: Type.Boolean(),
  revision: Type.Union([Revision, Type.Null()]),
  name: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  description: Type.Union([Type.String({ minLength: 1, maxLength: 8192 }), Type.Null()]),
  preview: Type.Union([Type.String({ minLength: 1, maxLength: 512 }), Type.Null()]),
});
export const ScenarioUpdateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Type.Union([Revision, Type.Literal(0)]),
  name: Type.String({ minLength: 1, maxLength: 128 }),
  description: Type.String({ minLength: 1, maxLength: 8192 }),
});
/** Player greeting set projection: variants with bounded label + verbatim text. */
export const GreetingV1Schema = strictObject({
  apiVersion: ApiVersion,
  present: Type.Boolean(),
  revision: Type.Union([Revision, Type.Null()]),
  label: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
  variants: Type.Array(
    strictObject({
      label: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
      text: Type.String({ minLength: 1, maxLength: 8192 }),
    }),
    { maxItems: 16 },
  ),
});
export const GreetingUpdateCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedRevision: Type.Union([Revision, Type.Literal(0)]),
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  variants: Type.Array(
    strictObject({
      label: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      text: Type.String({ minLength: 1, maxLength: 8192 }),
    }),
    { minItems: 1, maxItems: 16 },
  ),
});
/**
 * Chat lifecycle retention body. The exact Chat is named by the route path
 * handle and the operation by the route suffix (mirroring the connection
 * routes); the body carries only the CAS facts a browser can legitimately hold.
 * There is no selection generation: the target is named by its own handle, which
 * may be any Chat of the mounted companion/continuity - not only the mounted one.
 */
export const ChatRetentionCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  expectedManagementRevision: Revision,
});
export const ChatRetentionResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  handle: OpaqueHandle,
  status: Type.Union([Type.Literal("active"), Type.Literal("archived"), Type.Literal("trashed")]),
  managementRevision: Revision,
});
/** The whole exported chat file as text: 256 bubbles of at most 4 000 bytes, plus their JSON. */
export const CHAT_EXPORT_JSONL_MAX_LENGTH = 1_048_576;
/**
 * One fact the export dropped, in the interchange's own disposition vocabulary.
 *
 * An exported file is a subset of the conversation - only the selected variant of each turn, no
 * durable message identifiers - so the loss is reported beside the file rather than left for the
 * player to discover in SillyTavern.
 */
export const ChatExportDispositionV1Schema = strictObject({
  field: Type.String({ minLength: 1, maxLength: 128 }),
  classification: Type.Union([
    Type.Literal("accepted_typed"),
    Type.Literal("dropped_unsupported"),
    Type.Literal("rejected_invalid"),
  ]),
  reason: Type.String({ minLength: 1, maxLength: 128 }),
});
/**
 * `chat.export`: one Chat's transcript as a SillyTavern chat file.
 *
 * `jsonl` is the file itself - the header line plus one bubble per message - so the browser saves
 * exactly the bytes the Host's own exporter produced and never re-serializes the transcript.
 * `canonicalHash` is that exporter's hash over the unsigned content, and `dispositions` says what
 * the file does not carry. No durable thread/surface identifier, variant set or binding is
 * expressible here.
 */
export const ChatExportV1Schema = strictObject({
  apiVersion: ApiVersion,
  format: Type.Literal("tavern-interchange/v1"),
  chatHandle: OpaqueHandle,
  messageCount: Revision,
  dispositions: Type.Array(ChatExportDispositionV1Schema, { maxItems: 8 }),
  canonicalHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" }),
  jsonl: Type.String({ minLength: 1, maxLength: CHAT_EXPORT_JSONL_MAX_LENGTH }),
});
/** `chat.export`'s own query: the exact Chat the browser's list handed out. */
export const ChatExportQueryV1Schema = strictObject({ chatHandle: OpaqueHandle });

export const TavernStateEventStreamV1Schema = strictObject({ epoch: OpaqueHandle, cursor: OpaqueHandle });

/**
 * Voice surface narrow projection (additive optional in v1): a redacted,
 * device-free Voice Gateway state for the input-adjacent status icon.
 * `unavailable` = no usable audio surface; `ready` = PTT available;
 * `speaking` = companion utterance is playing (barge-in possible).
 *
 * Reserved: `unavailable` has no producer on this wire. The one production reader
 * (`voice-gateway-client.ts`, `createVoiceSurfaceReader`) emits only `ready` and
 * `speaking`; an absent or null `voice` field is how "no usable audio surface" is
 * published today. The member stays declared for a producer that can say it.
 *
 * There is deliberately no `listening`/`capturing` member, and no producer for one could exist
 * today: this product has no audio-capture path at all. Nothing in `host/`, `dialogue-web/` or
 * `desktop/` opens a microphone - `MediaRecorder`, `getUserMedia`, speech-to-text and any
 * audio-carrying request body appear nowhere in production code. The Desktop Voice lane is
 * output-only (`VoiceLaunchCoordinator.cs` admits a TTS artifact and injects the loopback
 * port/token so the Host can connect the gateway for SPEECH), and `voice-gateway-client.ts`'s
 * audio-epoch admission fences outbound playback, not captured input. The front end's mic thus
 * renders only what the Host reports, and the browser's own MediaRecorder is - correctly - not a
 * Host fact (`dialogue-web/src/components/Composer.tsx`).
 *
 * Closing it would take, in order: a component that captures (browser `getUserMedia` +
 * `MediaRecorder`, or a native desktop capture), a bounded Host route that carries the audio (a new
 * operation with its own admission, byte bound and redaction), a Host action on that audio
 * (speech-to-text into a player message, with the provider and the `chat.submit`-adjacent
 * admission that implies), and a durable capture state with a deadline and a producer. Only then
 * would the member mean something; declaring it first would be a state nobody can produce.
 */
export const TavernVoiceSurfaceStateV1Schema = strictObject({
  state: Type.Union([Type.Literal("unavailable"), Type.Literal("ready"), Type.Literal("speaking")]),
});

/**
 * The bounded MIMO voice persona id (`null` = no persona selected). The set of
 * ids is the extension's (`MIMO_TTS_PERSONAS`); this contract binds only the
 * shape, so the catalogue can grow without a Host edit.
 */
export const TavernVoicePersonaV1Schema = Type.Union([
  Type.Null(),
  Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$", maxLength: 32 }),
]);
/** Host-owned cloud TTS disclosure and consent projection. No credentials or provider facts are expressible. */
export const TavernVoicePreferenceV1Schema = strictObject({
  revision: Revision,
  disclosureVersion: Type.Union([Type.Literal("mimo-cloud-tts-v1"), Type.Null()]),
  consent: Type.Union([Type.Literal("undecided"), Type.Literal("accepted"), Type.Literal("revoked")]),
  decidedAtMs: Type.Union([Revision, Type.Null()]),
  /** `null` = Windows default output; `waveout:N` pins one enumerated endpoint. */
  outputDevice: Type.Union([Type.Null(), Type.String({ pattern: "^waveout:[0-9]{1,4}$", maxLength: 16 })]),
  // The selected MIMO voice persona (`GAMEBUDDY_MIMO_PERSONA`): null means no
  // persona chosen; the desktop entry then resolves the product's default persona
  // (and clamps an unlisted id) so a consented player hears the companion by
  // default. Same bounded lowercase-snake shape the store enforces.
  persona: TavernVoicePersonaV1Schema,
});
export const TavernVoicePreferenceConsentCommandV1Schema = Type.Union([
  strictObject({
    expectedRevision: Revision,
    action: Type.Literal("accept"),
    disclosureVersion: Type.Literal("mimo-cloud-tts-v1"),
  }),
  strictObject({
    expectedRevision: Revision,
    action: Type.Literal("revoke"),
  }),
  strictObject({
    expectedRevision: Revision,
    action: Type.Literal("setOutputDevice"),
    outputDevice: Type.Union([Type.Null(), Type.String({ pattern: "^waveout:[0-9]{1,4}$", maxLength: 16 })]),
  }),
  strictObject({
    expectedRevision: Revision,
    action: Type.Literal("setPersona"),
    persona: TavernVoicePersonaV1Schema,
  }),
]);

/**
 * Read-only enumeration of the output endpoints the Voice Gateway can render
 * to. `id` is the frozen `waveout:N` selection stored by the preference; `name`
 * is the driver's bounded display label. An empty list means no enumerable
 * endpoint is available (gateway absent, non-Windows, or headless).
 */
export const TavernVoiceDevicesV1Schema = strictObject({
  devices: Type.Array(
    strictObject({
      id: Type.String({ pattern: "^waveout:[0-9]{1,4}$", maxLength: 16 }),
      name: Type.String({ minLength: 1, maxLength: 128 }),
    }),
    { maxItems: 32 },
  ),
  /** The Windows default endpoint is always selectable and is not enumerated. */
  defaultSelectable: Type.Literal(true),
});

/**
 * Host-owned companion language preference. The Tavern (frontend) is the
 * single configuration point for the companion language: Agent session
 * language, companion presentation locale and fixture required-live-locale all
 * derive from it instead of each side hard-coding its own.
 */
export const TavernCompanionLocaleV1Schema = Type.String({
  minLength: 2,
  maxLength: 64,
  pattern: "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$",
});

export const TavernLanguagePreferenceV1Schema = strictObject({
  revision: Revision,
  locale: Type.Union([TavernCompanionLocaleV1Schema, Type.Null()]),
});
export const TavernLanguagePreferenceCommandV1Schema = strictObject({
  expectedRevision: Revision,
  locale: TavernCompanionLocaleV1Schema,
});

/**
 * Host-owned delivery preference: whether Chat replies arrive as short paced
 * pieces instead of one whole message.
 *
 * It reads exactly what the player chose; which surfaces honour it, and how an
 * un-chosen record falls for each of them, belongs to the delivery path rather
 * than to this wire.
 */
export const TavernDeliveryPreferenceV1Schema = strictObject({
  revision: Revision,
  paced: Type.Boolean(),
});
export const TavernDeliveryPreferenceCommandV1Schema = strictObject({
  expectedRevision: Revision,
  paced: Type.Boolean(),
});

/**
 * The player's own addition to the Game companion's starting instructions.
 *
 * The addition is an ADDITION, and the wire says so by carrying only the addition: it is
 * rendered AFTER the Host floor (observation honesty, the emote channel, the player's
 * language), which is what makes those rules un-editable from a settings field. `revision`
 * is the shared record's, so a write here cannot silently discard a concurrent language or
 * voice write.
 *
 * An empty `addition` is the player having added nothing, which is a different fact from a
 * never-written record at `revision: 0`.
 */
export const TavernGamePromptAdditionV1Schema = strictObject({
  revision: Revision,
  addition: Type.String({
    maxLength: MAX_GAME_PROMPT_ADDITION_CHARS,
    format: "tavern-browser-game-prompt-addition-v1",
  }),
});
export const TavernGamePromptAdditionCommandV1Schema = strictObject({
  expectedRevision: Revision,
  addition: Type.String({
    maxLength: MAX_GAME_PROMPT_ADDITION_CHARS,
    format: "tavern-browser-game-prompt-addition-v1",
  }),
});

const MemoryStateSnapshotV1Schema = Type.Union([
  strictObject({
    readAvailable: Type.Literal(true),
    mutationAvailable: Type.Boolean(),
    projectionRevision: OpaqueHandle,
  }),
  strictObject({
    readAvailable: Type.Literal(false),
    mutationAvailable: Type.Literal(false),
    projectionRevision: Type.Null(),
  }),
]);

export const TavernStateSnapshotV1Schema = strictObject({
  apiVersion: ApiVersion,
  build: strictObject({
    browserContract: Type.Literal(TAVERN_BROWSER_API_V1),
    profileId: Type.String({ minLength: 1, maxLength: 128 }),
  }),
  csrfToken: OpaqueHandle,
  browserSession: strictObject({ expiresAtMs: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }),
  operations: Type.Array(TavernBrowserOperationV1Schema, {}),
  navigation: Type.Array(NavigationItem, {}),
  selection: Type.Union([
    Type.Null(),
    strictObject({ chatHandle: OpaqueHandle, generation: PositiveGeneration, stateRevision: OpaqueHandle }),
  ]),
  chat: Type.Union([
    Type.Null(),
    strictObject({
      companion: strictObject({
        name: Type.String({ minLength: 1, maxLength: 256 }),
        /**
         * The opaque handle the roster handed out for the mounted companion, so
         * the transcript addresses her picture exactly the way every other
         * companion-addressed read does. Never a durable companion id.
         */
        handle: OpaqueHandle,
      }),
      title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
      transcript: Type.Array(BrowserMessageV1Schema),
      draft: strictObject({ revision: Revision, present: Type.Boolean() }),
      turn: Type.Union([BrowserTurnV1Schema, Type.Null()]),
      worldInfo: Type.Union([Type.Null(), WorldInfoStateV1Schema]),
    }),
  ]),
  memory: MemoryStateSnapshotV1Schema,
  // Additive optional v1 field (兼容 additive): old shell clients that predate
  // this field simply do not render the mic icon; there is no v1 break.
  voice: Type.Optional(Type.Union([Type.Null(), TavernVoiceSurfaceStateV1Schema])),
  eventStream: Type.Union([Type.Null(), TavernStateEventStreamV1Schema]),
});
export const SubmitMessageCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  text: BoundedText,
  // The language of the PLAYER'S OWN message, which the UI knows because it produced
  // the text (it is the interface locale, not the companion's language: the companion's
  // language is the player preference and is what the prompt is instructed with). This
  // is the pair this UI is localized for, and `und` covers a message the UI could not
  // classify.
  locale: Type.Union([Type.Literal("en"), Type.Literal("zh-CN")]),
  expectedDraftRevision: Type.Optional(Revision),
});
export const SaveDraftCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: Revision,
  text: BoundedText,
});
export const DiscardDraftCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  expectedRevision: Revision,
});
export const ChatListQueryV1Schema = strictObject({
  apiVersion: ApiVersion,
  state: Type.Optional(Type.Literal("active")),
});
/**
 * The exact ceiling the contract puts on `ChatListEntryV1.preview`. Exported so a
 * producer cannot pick its own bound and so this module's own truncation is the
 * length the schema accepts.
 */
export const CHAT_LIST_PREVIEW_MAX_LENGTH = 160;

/**
 * Turns a durable message text into the list row's plain-text preview: an action
 * marker (`*...*`) loses its delimiter, a `{{macro}}` run is removed, runs of
 * whitespace collapse, and the result is truncated to the contract's own ceiling
 * with an ellipsis. `null` in, `null` out; a message that is nothing but markup
 * previews as `null` rather than as an empty string.
 */
export function chatListPreviewText(text: string | null): string | null {
  if (text === null) return null;
  const plain = text
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/[{}*]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
  if (plain.length === 0) return null;
  if (plain.length <= CHAT_LIST_PREVIEW_MAX_LENGTH) return plain;
  return `${plain.slice(0, CHAT_LIST_PREVIEW_MAX_LENGTH - 1)}…`;
}
/** Metadata-only Chat list entry: no durable identifier ever appears. */
export const ChatListEntryV1Schema = strictObject({
  handle: OpaqueHandle,
  title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  status: Type.Literal("active"),
  managementRevision: Revision,
  isSelected: Type.Boolean(),
  /**
   * The thread's own durable last-activity time. It is what makes two rows that
   * share a title (`null` for every Chat the player never renamed) distinguishable
   * without a rename: no new durable state, the store has carried it all along.
   */
  updatedAtMs: Revision,
  /**
   * Plain-text preview of the last message, already stripped of action markers and
   * macro residue and bounded by `CHAT_LIST_PREVIEW_MAX_LENGTH`; `null` for a Chat
   * with no message at all (a genuinely blank opening), never "absent".
   */
  preview: Type.Union([Type.String({ maxLength: CHAT_LIST_PREVIEW_MAX_LENGTH }), Type.Null()]),
});
export const ChatListV1Schema = strictObject({
  apiVersion: ApiVersion,
  /**
   * Every Chat of the partition. Unbounded on purpose: the list is the only way
   * the surface reaches a Chat at all (no paging, no query), so a ceiling here
   * would be a ceiling on how many Chats a player may own - the 101st would make
   * the whole read refuse and blank a list that is otherwise perfectly legal.
   */
  chats: Type.Array(ChatListEntryV1Schema),
});
export const RenameChatTitleCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  chatHandle: OpaqueHandle,
  expectedManagementRevision: Revision,
  title: TitleText,
});
export const ChatTitleV1Schema = strictObject({
  apiVersion: ApiVersion,
  title: Type.Union([Type.String({ maxLength: 256 }), Type.Null()]),
  managementRevision: Revision,
});
export const MessageSubmissionStatusQueryV1Schema = strictObject({
  apiVersion: ApiVersion,
  idempotencyKey: IdempotencyKey,
  selectionGeneration: PositiveGeneration,
});
export const CancelTurnCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
});
export const SwipeSelectCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
  direction: Type.Optional(Type.Union([Type.Literal("prev"), Type.Literal("next")])),
  targetIndex: Type.Optional(Revision),
});
export const SwipeSelectResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  message: BrowserMessageV1Schema,
});
/**
 * Discarding ONE variant of a reply position (`chat.swipe.remove`): the position the player is looking
 * at offers several attempts, and they throw one of them away without throwing the reply away. That is
 * the thing neither `chat.rewind` (which drops everything after a point) nor `chat.delete` (which drops
 * the whole reply, every variant with it) can do, and it is what a SillyTavern user does by deleting a
 * single swipe.
 *
 * `targetIndex` is the variant position the browser rendered, 0-based, exactly as `chat.swipe` names
 * one. The position is CASed by the same two facts that command uses - the session's own
 * `selectionGeneration` and the reply's opaque `messageHandle` - so this is the swipe family's shape, not
 * a second mutation vocabulary: it carries no idempotency key (neither does the swipe), because a
 * removal names a state the caller just read and is not a retryable request to a provider. A reply that
 * would be left with no words is refused by name (`chat_swipe_last_variant`): the reply itself is the
 * delete's job.
 */
export const SwipeRemoveCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
  targetIndex: Revision,
});
export const RegenerateMessageCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
});
/**
 * Rewinding a conversation (`chat.rewind`): the named message is KEPT and every message after it
 * stops being part of the conversation - in the transcript the player reads AND in the model's own
 * session, which is the invariant the whole operation exists for. That is the shape both references
 * have: SillyTavern truncates after the point and Pi moves the session leaf to that entry, so the
 * player can regenerate what followed, or answer their own kept line again. A rewind that only hid
 * rows in the projection would leave the model reading text the player can no longer see.
 *
 * `expectedOrder` is the transcript position the browser rendered that message at. The transcript
 * is what the position means, so a message that has moved - because a turn landed between the read
 * and the click - is refused rather than used as a rewind point the player never chose.
 */
export const RewindChatCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
  expectedOrder: Revision,
});
export const RewindChatResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  /** The row that now ends the transcript, or `null` when the rewind emptied it. */
  lastMessage: Type.Union([BrowserMessageV1Schema, Type.Null()]),
});
/**
 * Editing one message the player and the companion exchanged, in place (`chat.edit`): the message
 * carries different text from now on - in the durable transcript the player reads AND in the model's own
 * session, which is the invariant the whole operation exists for. An edit that only changed the bubble
 * would leave the model answering words the player no longer says.
 *
 * The two editable messages are the player's own and the companion's reply; a reply's words are also the
 * variant its row carries, and the Host rewrites both with the edit. The greeting the Chat opened on is
 * not an exchange and has its own editor.
 *
 * `expectedOrder` is the transcript position the browser rendered that message at. The transcript is
 * what the position means, so a row that has moved - because a rewind landed between the read and the
 * save - is refused rather than edited where the player never saw it.
 */
export const EditMessageCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
  expectedOrder: Revision,
  text: BoundedText,
});
export const EditMessageResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  /** The edited row, projected from the durable read-back rather than from the command's echo. */
  message: BrowserMessageV1Schema,
});
/**
 * Deleting one message out of the middle of a conversation (`chat.delete`): the named row leaves the
 * transcript, the rows after it keep their order, and the model's own session stops carrying exactly
 * that row's entry - which is the invariant the whole operation exists for, the same one a rewind and
 * an edit keep. A delete that only removed the bubble would leave the model answering words the player
 * can no longer read, and one that removed MORE than the named row would be a rewind.
 *
 * `expectedOrder` is the transcript position the browser rendered that message at. The transcript is
 * what the position means, so a row that has moved - because a turn landed between the read and the
 * click - is refused rather than deleted where the player never saw it.
 *
 * The answer carries nothing but the protocol version: unlike a rewind, which has to tell the browser
 * where the conversation now ends, a delete leaves a gap whose whole point is that the surface must
 * reread the transcript rather than be told what occupies it.
 */
export const DeleteMessageCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  messageHandle: OpaqueHandle,
  expectedOrder: Revision,
});
export const DeleteMessageResultV1Schema = strictObject({
  apiVersion: ApiVersion,
});
/**
 * New-chat opening variant choice. The browser names no durable greeting id and no chat id: the
 * mounted companion's own greeting set is resolved by the Host, and the mounted Chat is the one
 * the admission already bound. `targetIndex` is 0-based; `direction` steps from the committed
 * variant. At least one of the two must be present.
 */
export const ChatOpeningCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  direction: Type.Optional(Type.Union([Type.Literal("prev"), Type.Literal("next")])),
  targetIndex: Type.Optional(Revision),
});
export const ChatOpeningResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  openingVariant: BrowserOpeningVariantV1Schema,
});
/**
 * New Chat (design/26 §4.4). The browser names nothing durable - no companion, continuity,
 * greeting or Chat id: the Host mints the thread identity, resolves the mounted companion's own
 * greeting as the opening, and answers with the created Chat's metadata-only list entry. `opening`
 * is the durable message-zero text when the created Chat opened on a greeting, and null when its
 * opening is genuinely blank, so the surface can render message 0 before it claims success
 * (design/26 §4.4) without inventing one. The new Chat is NOT the mounted one: `isSelected` is
 * false, and it becomes active only through the selection a later runtime start settles.
 */
export const CreateChatCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
});
export const ChatCreateResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  chat: ChatListEntryV1Schema,
  opening: Type.Union([Type.String({ minLength: 1, maxLength: 8192 }), Type.Null()]),
});
/**
 * Chat selection (ADR 0009 / ADR-0010). The browser names the exact Chat it read from `chat.list`
 * and the selection generation it read. Switching is turn-level: the runtime hot-swaps the mounted
 * conversation inside the same process and answers `switched`. Selecting another Chat is a focus
 * transfer, so a turn that is still generating is aborted first through the same cancel path an
 * explicit browser Stop uses; `turn_in_flight` is only the bounded residual answer for a durable
 * turn whose attempt has not started yet. Either way the recorded selection is durable, so a later
 * start still lands on the Chat the player chose.
 */
export const SelectChatCommandV1Schema = strictObject({
  apiVersion: ApiVersion,
  selectionGeneration: PositiveGeneration,
  chatHandle: OpaqueHandle,
});
export const ChatSelectResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  status: Type.Union([Type.Literal("switched"), Type.Literal("turn_in_flight")]),
});
export const SubmitResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  disposition: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate")]),
  message: BrowserMessageV1Schema,
  turn: BrowserTurnV1Schema,
});
export const MessageSubmissionStatusV1Schema = strictObject({
  apiVersion: ApiVersion,
  disposition: Type.Union([
    Type.Literal("unknown"),
    Type.Literal("pending"),
    Type.Literal("accepted"),
    Type.Literal("terminal"),
    Type.Literal("expired"),
  ]),
  committedResult: Type.Optional(SubmitResultV1Schema),
});
export const CancelTurnResultV1Schema = strictObject({
  apiVersion: ApiVersion,
  disposition: Type.Union([
    Type.Literal("cancelled"),
    Type.Literal("completion_won"),
    Type.Literal("already_terminal"),
  ]),
  turn: BrowserTurnV1Schema,
});
export const TavernProblemV1Schema = strictObject({
  type: Type.String({ minLength: 1, maxLength: 256 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  status: Type.Integer({ minimum: 400, maximum: 599 }),
  code: ProblemCode,
  requestId: OpaqueHandle,
  retryable: Type.Boolean(),
});

const EventBase = {
  apiVersion: ApiVersion,
  epoch: OpaqueHandle,
  sequence: PositiveGeneration,
  selectionGeneration: PositiveGeneration,
};
const CompanionDeltaV1Schema = strictObject({
  /** Opaque Host projection of the exact mounted turn; never a Pi message ID. */
  turnHandle: OpaqueHandle,
  delta: BoundedText,
});
export const BrowserEventV1Schema = Type.Union([
  strictObject({ ...EventBase, eventType: Type.Literal("companion.delta"), payload: CompanionDeltaV1Schema }),
  strictObject({ ...EventBase, eventType: Type.Literal("message.committed"), payload: BrowserMessageV1Schema }),
  strictObject({
    ...EventBase,
    eventType: Type.Literal("draft.changed"),
    payload: strictObject({ revision: Revision, present: Type.Boolean() }),
  }),
  strictObject({ ...EventBase, eventType: Type.Literal("turn.state_changed"), payload: BrowserTurnV1Schema }),
  strictObject({
    ...EventBase,
    eventType: Type.Literal("stream.resync_required"),
    payload: strictObject({
      reason: Type.Union([
        Type.Literal("gap"),
        Type.Literal("epoch_changed"),
        Type.Literal("restart"),
        Type.Literal("ambiguous_cursor"),
      ]),
    }),
  }),
]);

/**
 * The browser-visible half of the closed `ProblemCode` union: the flat list a surface reads to
 * name every refusal the Host can send. It is pinned to the union's own members just below, so a
 * code the Host can send is always published.
 */
export const TAVERN_BROWSER_PROBLEM_CODES_V1 = Object.freeze([
  "unauthorized",
  "csrf_failed",
  "invalid_request",
  "unsupported_api_version",
  "profile_operation_unavailable",
  "st_card_import_rejected",
  "character_import_not_found",
  "character_import_review_invalid",
  "character_import_confirm_invalid",
  "selection_conflict",
  "draft_conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "turn_busy",
  "stream_resync_required",
  "selection_busy",
  "turn_not_active",
  "turn_already_terminal",
  "runtime_unavailable",
  "presentation_unavailable",
  "storage_unavailable",
  "state_reconciliation_required",
  "settings_revision_conflict",
  "dialogue_busy",
  "connection_not_found",
  "connection_not_ready",
  "connection_conflict",
  "connection_limit_reached",
  "companion_not_found",
  "companion_conflict",
  "persona_conflict",
  "scenario_conflict",
  "greeting_conflict",
  "authored_content_invalid",
  "chat_opening_locked",
  "chat_opening_not_greeting",
  "chat_opening_variant_not_found",
  "chat_swipe_last_variant",
  "chat_message_not_found",
  "chat_message_revision_conflict",
  "chat_rewind_opening_retained",
  "chat_rewind_turn_active",
  "chat_edit_turn_active",
  "chat_delete_opening_retained",
  "chat_delete_turn_active",
  "chat_delete_binding_unavailable",
  "chat_not_found",
  "companion_record_unreadable",
  "character_voice_conflict",
  "character_voice_turn_active",
  "companion_world_book_conflict",
  "companion_world_book_absent",
  "companion_world_book_binding_partial",
  "world_info_not_found",
  "world_info_already_exists",
  "world_info_revision_conflict",
  "world_info_in_use",
  "companion_card_too_large",
  "companion_card_image_absent",
  "companion_avatar_too_large",
  "companion_avatar_malformed",
  "companion_delete_in_play",
] as const);

const unionProblemCodes: readonly string[] = ProblemCode.anyOf.map((literal) => literal.const);
const publishedProblemCodes: readonly string[] = TAVERN_BROWSER_PROBLEM_CODES_V1;
// The published list is a projection of the closed union, not a second authority: a code in
// either list without the other publishes a vocabulary the Host and the client disagree about.
// Deriving the list would hide a literal dropped from the union, because the list would drop
// with it and every check against the list would still pass; pinning the two equal fails closed
// here instead, before a consumer can serve a vocabulary that omits a code the Host can send.
if (
  unionProblemCodes.length !== publishedProblemCodes.length ||
  unionProblemCodes.some((code) => !publishedProblemCodes.includes(code))
) {
  throw new Error("tavern_browser_problem_codes_drift");
}

const EmptyHeaders = strictObject({});
const CsrfHeaders = strictObject({ "x-csrf-token": OpaqueHandle });
const IdempotentCsrfHeaders = strictObject({ "x-csrf-token": OpaqueHandle, "idempotency-key": IdempotencyKey });
const BootstrapRequest = strictObject({ apiVersion: ApiVersion, bootstrapToken: OpaqueHandle });
const TurnPath = strictObject({ turnHandle: OpaqueHandle });
const ConnectionPath = strictObject({ connectionId: OpaqueHandle });
const CompanionPath = strictObject({ companionHandle: OpaqueHandle });
const ImportPath = strictObject({ importId: OpaqueHandle });
const ChatPath = strictObject({ chatHandle: OpaqueHandle });
const EventsQuery = strictObject({ apiVersion: ApiVersion, cursor: Type.Optional(OpaqueHandle) });
const noQuery = strictObject({});
const noPath = strictObject({});
/**
 * `companion.card.export`'s own query: which form of the card to build. It is
 * REQUIRED and named, never guessed - the plain `GET .../card` is not a card of
 * some defaulted kind, because a file's format is a decision the caller makes and
 * the Host records, not one an extension or a default can imply.
 */
const CompanionCardFormatQuery = strictObject({ format: Type.Union([Type.Literal("json"), Type.Literal("png")]) });
type RouteDescriptor = Readonly<{
  routeId: string;
  method: string;
  path: string;
  operationId?: TavernBrowserOperationIdV1;
  auth: string;
  origin: string;
  csrf: string;
  idempotency: string;
  headers: TSchema;
  pathParams: TSchema;
  query: TSchema;
  request?: TSchema;
  success: Readonly<{ status: number; contentType: string; schema: TSchema }>;
}>;
const route = <T extends RouteDescriptor>(descriptor: T) => Object.freeze(descriptor);
const RouteDescriptors = Object.freeze([
  route({
    routeId: "bootstrap",
    method: "POST",
    path: "/api/tavern/v1/bootstrap",
    auth: "bootstrap_token",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    request: BootstrapRequest,
    success: { status: 200, contentType: "application/json", schema: TavernStateSnapshotV1Schema },
  }),
  route({
    routeId: "state.read",
    method: "GET",
    path: "/api/tavern/v1/state",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernStateSnapshotV1Schema },
  }),
  route({
    routeId: "draft.read",
    method: "GET",
    path: "/api/tavern/v1/draft",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: BrowserDraftV1Schema },
  }),
  route({
    routeId: "draft.save",
    method: "PUT",
    path: "/api/tavern/v1/draft",
    operationId: "draft.save",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SaveDraftCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: BrowserDraftV1Schema },
  }),
  route({
    routeId: "draft.discard",
    method: "DELETE",
    path: "/api/tavern/v1/draft",
    operationId: "draft.discard",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: DiscardDraftCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: BrowserDraftV1Schema },
  }),
  route({
    routeId: "chat.submit",
    method: "POST",
    path: "/api/tavern/v1/messages",
    operationId: "chat.submit",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "required",
    headers: IdempotentCsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SubmitMessageCommandV1Schema,
    success: { status: 202, contentType: "application/json", schema: SubmitResultV1Schema },
  }),
  route({
    routeId: "chat.submission_status",
    method: "POST",
    path: "/api/tavern/v1/message-submission-status",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "query_key",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    request: MessageSubmissionStatusQueryV1Schema,
    success: { status: 200, contentType: "application/json", schema: MessageSubmissionStatusV1Schema },
  }),
  route({
    routeId: "chat.list",
    method: "GET",
    path: "/api/tavern/v1/chats",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: ChatListQueryV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatListV1Schema },
  }),
  route({
    routeId: "chat.rename",
    method: "PUT",
    path: "/api/tavern/v1/chat/title",
    operationId: "chat.rename",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: RenameChatTitleCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatTitleV1Schema },
  }),
  route({
    routeId: "chat.opening",
    method: "PUT",
    path: "/api/tavern/v1/chat/opening",
    operationId: "chat.opening",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: ChatOpeningCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatOpeningResultV1Schema },
  }),
  route({
    routeId: "chat.create",
    method: "POST",
    path: "/api/tavern/v1/chats",
    operationId: "chat.create",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: CreateChatCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatCreateResultV1Schema },
  }),
  route({
    routeId: "chat.select",
    method: "PUT",
    path: "/api/tavern/v1/chat/select",
    operationId: "chat.select",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SelectChatCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatSelectResultV1Schema },
  }),
  route({
    routeId: "chat.cancel",
    method: "POST",
    path: "/api/tavern/v1/turns/:turnHandle/cancel",
    operationId: "chat.cancel",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: TurnPath,
    query: noQuery,
    request: CancelTurnCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CancelTurnResultV1Schema },
  }),
  route({
    routeId: "chat.swipe",
    method: "POST",
    path: "/api/tavern/v1/messages/swipe",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SwipeSelectCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: SwipeSelectResultV1Schema },
  }),
  route({
    routeId: "chat.swipe.remove",
    method: "POST",
    path: "/api/tavern/v1/messages/swipe/remove",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SwipeRemoveCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: SwipeSelectResultV1Schema },
  }),
  route({
    routeId: "chat.regenerate",
    method: "POST",
    path: "/api/tavern/v1/messages/regenerate",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "required",
    headers: IdempotentCsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: RegenerateMessageCommandV1Schema,
    success: { status: 202, contentType: "application/json", schema: SubmitResultV1Schema },
  }),
  route({
    routeId: "chat.rewind",
    method: "POST",
    path: "/api/tavern/v1/messages/rewind",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: RewindChatCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: RewindChatResultV1Schema },
  }),
  route({
    routeId: "chat.edit",
    method: "POST",
    path: "/api/tavern/v1/messages/edit",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: EditMessageCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: EditMessageResultV1Schema },
  }),
  route({
    routeId: "chat.delete",
    method: "POST",
    path: "/api/tavern/v1/messages/delete",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: DeleteMessageCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: DeleteMessageResultV1Schema },
  }),
  route({
    routeId: "memory.read",
    method: "GET",
    path: "/api/tavern/v1/memory",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: MemoryReadV1Schema },
  }),
  route({
    routeId: "memory.mutate",
    method: "PUT",
    path: "/api/tavern/v1/memory",
    operationId: "memory.mutate",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: MemoryMutationCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: MemoryMutationResultV1Schema },
  }),
  route({
    routeId: "world-info.read",
    method: "GET",
    path: "/api/tavern/v1/world-info",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  route({
    routeId: "world-info.bind",
    method: "PUT",
    path: "/api/tavern/v1/world-info",
    operationId: "world-info.bind",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: SetWorldInfoBindingCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  // The managed library's authoring group: reading one item's own content and creating,
  // rewriting or removing it. All four address an item by an opaque handle from the exact
  // current projection, and the mutations answer with the re-projected library state, so a
  // caller re-renders from the Host's own answer instead of a local guess.
  route({
    routeId: "world-info.detail",
    method: "GET",
    path: "/api/tavern/v1/world-info/item",
    operationId: "world-info.detail",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: WorldInfoItemCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoItemV1Schema },
  }),
  route({
    routeId: "world-info.create",
    method: "POST",
    path: "/api/tavern/v1/world-info/item",
    operationId: "world-info.create",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: WorldInfoCreateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  route({
    routeId: "world-info.update",
    method: "PUT",
    path: "/api/tavern/v1/world-info/item",
    operationId: "world-info.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: WorldInfoUpdateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  route({
    routeId: "world-info.delete",
    method: "DELETE",
    path: "/api/tavern/v1/world-info/item",
    operationId: "world-info.delete",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: WorldInfoItemCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  // The one route that serves the library's existing lorebook importer to the player. It carries
  // a whole external file and answers with the re-projected library, exactly like `world-info.create`.
  route({
    routeId: "world-info.import",
    method: "POST",
    path: "/api/tavern/v1/world-info/import",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: WorldInfoImportCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: WorldInfoStateV1Schema },
  }),
  route({
    routeId: "settings.voice.read",
    method: "GET",
    path: "/api/tavern/v1/settings/voice-preference",
    operationId: "settings.voice.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernVoicePreferenceV1Schema },
  }),
  route({
    routeId: "settings.voice.consent",
    method: "PUT",
    path: "/api/tavern/v1/settings/voice-preference",
    operationId: "settings.voice.consent",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: TavernVoicePreferenceConsentCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernVoicePreferenceV1Schema },
  }),
  route({
    routeId: "settings.voice.devices",
    method: "GET",
    path: "/api/tavern/v1/settings/voice-devices",
    operationId: "settings.voice.devices",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernVoiceDevicesV1Schema },
  }),
  route({
    routeId: "settings.language.read",
    method: "GET",
    path: "/api/tavern/v1/settings/language",
    operationId: "settings.language.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernLanguagePreferenceV1Schema },
  }),
  route({
    routeId: "settings.language.update",
    method: "PUT",
    path: "/api/tavern/v1/settings/language",
    operationId: "settings.language.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: TavernLanguagePreferenceCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernLanguagePreferenceV1Schema },
  }),
  route({
    routeId: "settings.delivery.read",
    method: "GET",
    path: "/api/tavern/v1/settings/delivery",
    operationId: "settings.delivery.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernDeliveryPreferenceV1Schema },
  }),
  route({
    routeId: "settings.delivery.update",
    method: "PUT",
    path: "/api/tavern/v1/settings/delivery",
    operationId: "settings.delivery.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: TavernDeliveryPreferenceCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernDeliveryPreferenceV1Schema },
  }),
  route({
    routeId: "settings.game-prompt.read",
    method: "GET",
    path: "/api/tavern/v1/settings/game-prompt",
    operationId: "settings.game-prompt.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernGamePromptAdditionV1Schema },
  }),
  route({
    routeId: "settings.game-prompt.update",
    method: "PUT",
    path: "/api/tavern/v1/settings/game-prompt",
    operationId: "settings.game-prompt.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: TavernGamePromptAdditionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernGamePromptAdditionV1Schema },
  }),
  route({
    routeId: "settings.connection.read",
    method: "GET",
    path: "/api/tavern/v1/settings/connection",
    operationId: "settings.connection.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernConnectionStateV1Schema },
  }),
  route({
    routeId: "settings.connection.create",
    method: "POST",
    path: "/api/tavern/v1/settings/connections",
    operationId: "settings.connection.create",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: TavernConnectionCreateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernConnectionStateV1Schema },
  }),
  route({
    routeId: "settings.connection.test",
    method: "POST",
    path: "/api/tavern/v1/settings/connections/:connectionId/test",
    operationId: "settings.connection.test",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ConnectionPath,
    query: noQuery,
    request: TavernConnectionRevisionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernConnectionProbeV1Schema },
  }),
  route({
    routeId: "settings.connection.activate",
    method: "POST",
    path: "/api/tavern/v1/settings/connections/:connectionId/activate",
    operationId: "settings.connection.activate",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ConnectionPath,
    query: noQuery,
    request: TavernConnectionRevisionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernConnectionStateV1Schema },
  }),
  route({
    routeId: "settings.connection.model",
    method: "POST",
    path: "/api/tavern/v1/settings/connections/:connectionId/model",
    operationId: "settings.connection.model",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ConnectionPath,
    query: noQuery,
    request: TavernConnectionModelCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernConnectionStateV1Schema },
  }),
  route({
    routeId: "settings.connection.remove",
    method: "DELETE",
    path: "/api/tavern/v1/settings/connections/:connectionId",
    operationId: "settings.connection.remove",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ConnectionPath,
    query: noQuery,
    request: TavernConnectionRevisionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernConnectionStateV1Schema },
  }),
  route({
    routeId: "settings.profiles.read",
    method: "GET",
    path: "/api/tavern/v1/settings/profiles",
    operationId: "settings.profiles.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: TavernModelProfilesV1Schema },
  }),
  route({
    routeId: "settings.profiles.update",
    method: "PUT",
    path: "/api/tavern/v1/settings/profiles",
    operationId: "settings.profiles.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: TavernModelProfileUpdateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: TavernModelProfilesV1Schema },
  }),
  route({
    routeId: "events",
    method: "GET",
    path: "/api/tavern/v1/events",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: EventsQuery,
    success: { status: 200, contentType: "text/event-stream", schema: BrowserEventV1Schema },
  }),
  route({
    routeId: "companion.list",
    method: "GET",
    path: "/api/tavern/v1/companions",
    operationId: "companion.list",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: CompanionListV1Schema },
  }),
  route({
    routeId: "companion.worldbook.read",
    method: "GET",
    path: "/api/tavern/v1/companions/:companionHandle/worldbook",
    operationId: "companion.worldbook.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: CompanionWorldBookV1Schema },
  }),
  route({
    routeId: "companion.worldbook.update",
    method: "PUT",
    path: "/api/tavern/v1/companions/:companionHandle/worldbook",
    operationId: "companion.worldbook.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    request: UpdateCompanionWorldBookCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CompanionWorldBookV1Schema },
  }),
  route({
    routeId: "companion.profile.read",
    method: "GET",
    path: "/api/tavern/v1/companions/:companionHandle/profile",
    operationId: "companion.profile.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: CompanionProfileV1Schema },
  }),
  route({
    routeId: "companion.card.export",
    method: "GET",
    path: "/api/tavern/v1/companions/:companionHandle/card",
    operationId: "companion.card.export",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: CompanionPath,
    query: CompanionCardFormatQuery,
    success: { status: 200, contentType: "application/json", schema: CompanionCardExportV1Schema },
  }),
  route({
    routeId: "companion.avatar.update",
    method: "PUT",
    path: "/api/tavern/v1/companions/:companionHandle/avatar",
    operationId: "companion.avatar.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    request: CompanionAvatarUploadCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CompanionAvatarV1Schema },
  }),
  route({
    routeId: "companion.delete",
    method: "DELETE",
    path: "/api/tavern/v1/companions/:companionHandle",
    operationId: "companion.delete",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    request: DeleteCompanionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CompanionDeletionV1Schema },
  }),
  route({
    routeId: "companion.create",
    method: "POST",
    path: "/api/tavern/v1/companions",
    operationId: "companion.create",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: CreateCompanionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CompanionDetailV1Schema },
  }),
  route({
    routeId: "character.voice.read",
    method: "GET",
    path: "/api/tavern/v1/companions/:companionHandle/voice",
    operationId: "character.voice.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: CompanionVoiceV1Schema },
  }),
  route({
    routeId: "character.voice.update",
    method: "PUT",
    path: "/api/tavern/v1/companions/:companionHandle/voice",
    operationId: "character.voice.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: CompanionPath,
    query: noQuery,
    request: UpdateCompanionVoiceCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: CompanionVoiceV1Schema },
  }),
  route({
    routeId: "character.import.stage",
    method: "POST",
    path: "/api/tavern/v1/imports",
    operationId: "character.import.stage",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: StageStCardImportCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: StCardImportStageResultV1Schema },
  }),
  route({
    routeId: "character.import.read",
    method: "GET",
    path: "/api/tavern/v1/imports/:importId",
    operationId: "character.import.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: ImportPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: StCardImportReadResultV1Schema },
  }),
  route({
    routeId: "character.import.review",
    method: "POST",
    path: "/api/tavern/v1/imports/:importId/review",
    operationId: "character.import.review",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ImportPath,
    query: noQuery,
    request: ReviewStCardImportCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: StCardImportReviewResultV1Schema },
  }),
  route({
    routeId: "character.import.confirm",
    method: "POST",
    path: "/api/tavern/v1/imports/:importId/confirm",
    operationId: "character.import.confirm",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ImportPath,
    query: noQuery,
    request: ConfirmStCardImportCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: StCardImportConfirmResultV1Schema },
  }),
  route({
    routeId: "character.import.history",
    method: "GET",
    path: "/api/tavern/v1/import-history",
    operationId: "character.import.history",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: StCardImportHistoryV1Schema },
  }),
  route({
    routeId: "persona.read",
    method: "GET",
    path: "/api/tavern/v1/persona",
    operationId: "persona.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: PersonaV1Schema },
  }),
  route({
    routeId: "persona.update",
    method: "PUT",
    path: "/api/tavern/v1/persona",
    operationId: "persona.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: PersonaUpdateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: PersonaV1Schema },
  }),
  route({
    routeId: "scenario.read",
    method: "GET",
    path: "/api/tavern/v1/scenario",
    operationId: "scenario.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: ScenarioV1Schema },
  }),
  route({
    routeId: "scenario.update",
    method: "PUT",
    path: "/api/tavern/v1/scenario",
    operationId: "scenario.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: ScenarioUpdateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ScenarioV1Schema },
  }),
  route({
    routeId: "greeting.read",
    method: "GET",
    path: "/api/tavern/v1/greeting",
    operationId: "greeting.read",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: noQuery,
    success: { status: 200, contentType: "application/json", schema: GreetingV1Schema },
  }),
  route({
    routeId: "greeting.update",
    method: "PUT",
    path: "/api/tavern/v1/greeting",
    operationId: "greeting.update",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: noPath,
    query: noQuery,
    request: GreetingUpdateCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: GreetingV1Schema },
  }),
  route({
    routeId: "chat.archive",
    method: "POST",
    path: "/api/tavern/v1/chats/:chatHandle/archive",
    operationId: "chat.archive",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ChatPath,
    query: noQuery,
    request: ChatRetentionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatRetentionResultV1Schema },
  }),
  route({
    routeId: "chat.restore",
    method: "POST",
    path: "/api/tavern/v1/chats/:chatHandle/restore",
    operationId: "chat.restore",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ChatPath,
    query: noQuery,
    request: ChatRetentionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatRetentionResultV1Schema },
  }),
  route({
    routeId: "chat.trash",
    method: "POST",
    path: "/api/tavern/v1/chats/:chatHandle/trash",
    operationId: "chat.trash",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "required",
    idempotency: "none",
    headers: CsrfHeaders,
    pathParams: ChatPath,
    query: noQuery,
    request: ChatRetentionCommandV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatRetentionResultV1Schema },
  }),
  // The Chat transcript export: one Chat of this companion/continuity, named by its own handle,
  // answered as the interchange's own SillyTavern chat file.
  route({
    routeId: "chat.export",
    method: "GET",
    path: "/api/tavern/v1/chat/export",
    auth: "browser_session",
    origin: "same-origin",
    csrf: "none",
    idempotency: "none",
    headers: EmptyHeaders,
    pathParams: noPath,
    query: ChatExportQueryV1Schema,
    success: { status: 200, contentType: "application/json", schema: ChatExportV1Schema },
  }),
]);

export const TavernBrowserContractV1 = Object.freeze({
  id: TAVERN_BROWSER_API_V1,
  routes: RouteDescriptors,
  static: Object.freeze({
    shell: Object.freeze({ method: "GET", path: "/", auth: "none", origin: "same-origin", contentType: "text/html" }),
    assets: Object.freeze({
      method: "GET",
      path: "/assets/:assetPath",
      auth: "none",
      origin: "same-origin",
      contentType: "application/javascript|text/css|image/*|font/*",
    }),
  }),
  schemas: Object.freeze({
    BrowserMessageV1Schema,
    BrowserTurnV1Schema,
    BrowserDraftV1Schema,
    TavernBrowserOperationV1Schema,
    TavernStateEventStreamV1Schema,
    TavernVoiceSurfaceStateV1Schema,
    TavernVoicePreferenceV1Schema,
    TavernVoiceDevicesV1Schema,
    TavernVoicePreferenceConsentCommandV1Schema,
    TavernLanguagePreferenceV1Schema,
    TavernLanguagePreferenceCommandV1Schema,
    TavernDeliveryPreferenceV1Schema,
    TavernDeliveryPreferenceCommandV1Schema,
    TavernGamePromptAdditionV1Schema,
    TavernGamePromptAdditionCommandV1Schema,
    TavernStateSnapshotV1Schema,
    SubmitMessageCommandV1Schema,
    SaveDraftCommandV1Schema,
    DiscardDraftCommandV1Schema,
    MessageSubmissionStatusQueryV1Schema,
    CancelTurnCommandV1Schema,
    ChatListQueryV1Schema,
    ChatListEntryV1Schema,
    ChatListV1Schema,
    RenameChatTitleCommandV1Schema,
    ChatTitleV1Schema,
    MemoryItemV1Schema,
    MemoryReadV1Schema,
    MemoryMutationCommandV1Schema,
    MemoryMutationResultV1Schema,
    TavernConnectionSetupFieldV1Schema,
    TavernConnectionApiShapeV1Schema,
    TavernConnectionThinkingLevelV1Schema,
    TavernConnectionModelV1Schema,
    TavernConnectionProviderV1Schema,
    TavernConnectionV1Schema,
    TavernConnectionStateV1Schema,
    TavernConnectionReadV1Schema,
    TavernConnectionCreateCommandV1Schema,
    TavernConnectionRevisionCommandV1Schema,
    TavernConnectionModelCommandV1Schema,
    TavernConnectionProbeV1Schema,
    TavernRecommendedModelV1Schema,
    TavernModelProfileV1Schema,
    TavernModelProfilesV1Schema,
    TavernModelProfileUpdateCommandV1Schema,
    WorldInfoStateV1Schema,
    SetWorldInfoBindingCommandV1Schema,
    WorldInfoEntryV1Schema,
    WorldInfoItemV1Schema,
    WorldInfoItemCommandV1Schema,
    WorldInfoCreateCommandV1Schema,
    WorldInfoUpdateCommandV1Schema,
    WorldInfoImportCommandV1Schema,
    ChatExportDispositionV1Schema,
    ChatExportV1Schema,
    ChatExportQueryV1Schema,
    CompanionListEntryV1Schema,
    CompanionListV1Schema,
    CompanionDetailV1Schema,
    CompanionWorldBookEntryV1Schema,
    CompanionWorldBookV1Schema,
    UpdateCompanionWorldBookCommandV1Schema,
    CompanionProfileV1Schema,
    CompanionCardExportV1Schema,
    CompanionAvatarUploadCommandV1Schema,
    CompanionAvatarV1Schema,
    DeleteCompanionCommandV1Schema,
    CompanionDeletionV1Schema,
    CompanionVoiceV1Schema,
    CompanionCharacterVoiceV1Schema,
    UpdateCompanionVoiceCommandV1Schema,
    CreateCompanionCommandV1Schema,
    StCardImportFieldSummaryV1Schema,
    StCardImportDispositionV1Schema,
    StCardImportLossV1Schema,
    StageStCardImportCommandV1Schema,
    StCardImportStageResultV1Schema,
    StCardImportReadResultV1Schema,
    ReviewStCardImportCommandV1Schema,
    StCardImportReviewResultV1Schema,
    ConfirmStCardImportCommandV1Schema,
    StCardImportConfirmResultV1Schema,
    StCardImportDispositionCountsV1Schema,
    StCardImportHistoryEntryV1Schema,
    StCardImportHistoryV1Schema,
    PersonaV1Schema,
    PersonaUpdateCommandV1Schema,
    ScenarioV1Schema,
    ScenarioUpdateCommandV1Schema,
    GreetingV1Schema,
    GreetingUpdateCommandV1Schema,
    ChatRetentionCommandV1Schema,
    ChatRetentionResultV1Schema,
    SubmitResultV1Schema,
    MessageSubmissionStatusV1Schema,
    CancelTurnResultV1Schema,
    SwipeSelectCommandV1Schema,
    SwipeSelectResultV1Schema,
    SwipeRemoveCommandV1Schema,
    RegenerateMessageCommandV1Schema,
    RewindChatCommandV1Schema,
    RewindChatResultV1Schema,
    EditMessageCommandV1Schema,
    EditMessageResultV1Schema,
    DeleteMessageCommandV1Schema,
    DeleteMessageResultV1Schema,
    BrowserOpeningVariantV1Schema,
    ChatOpeningCommandV1Schema,
    ChatOpeningResultV1Schema,
    CreateChatCommandV1Schema,
    ChatCreateResultV1Schema,
    SelectChatCommandV1Schema,
    ChatSelectResultV1Schema,
    TavernProblemV1Schema,
    BrowserEventV1Schema,
  }),
});

export type BrowserSwipeInfoV1 = Static<typeof BrowserSwipeInfoV1Schema>;
export type BrowserMessageV1 = Static<typeof BrowserMessageV1Schema>;
export type BrowserTurnV1 = Static<typeof BrowserTurnV1Schema>;
export type BrowserDraftV1 = Static<typeof BrowserDraftV1Schema>;
export type SaveDraftCommandV1 = Static<typeof SaveDraftCommandV1Schema>;
export type DiscardDraftCommandV1 = Static<typeof DiscardDraftCommandV1Schema>;
export type TavernStateSnapshotV1 = Static<typeof TavernStateSnapshotV1Schema>;
export type TavernVoiceSurfaceStateV1 = Static<typeof TavernVoiceSurfaceStateV1Schema>;
export type TavernVoicePreferenceV1 = Static<typeof TavernVoicePreferenceV1Schema>;
export type TavernVoiceDevicesV1 = Static<typeof TavernVoiceDevicesV1Schema>;
export type TavernVoicePreferenceConsentCommandV1 = Static<typeof TavernVoicePreferenceConsentCommandV1Schema>;
export type TavernLanguagePreferenceV1 = Static<typeof TavernLanguagePreferenceV1Schema>;
export type TavernLanguagePreferenceCommandV1 = Static<typeof TavernLanguagePreferenceCommandV1Schema>;
export type TavernDeliveryPreferenceV1 = Static<typeof TavernDeliveryPreferenceV1Schema>;
export type TavernDeliveryPreferenceCommandV1 = Static<typeof TavernDeliveryPreferenceCommandV1Schema>;
export type TavernGamePromptAdditionV1 = Static<typeof TavernGamePromptAdditionV1Schema>;
export type TavernGamePromptAdditionCommandV1 = Static<typeof TavernGamePromptAdditionCommandV1Schema>;
export type StCardImportFieldSummaryV1 = Static<typeof StCardImportFieldSummaryV1Schema>;
export type StCardImportDispositionV1 = Static<typeof StCardImportDispositionV1Schema>;
export type StCardImportLossV1 = Static<typeof StCardImportLossV1Schema>;
export type StageStCardImportCommandV1 = Static<typeof StageStCardImportCommandV1Schema>;
export type StCardImportStageResultV1 = Static<typeof StCardImportStageResultV1Schema>;
export type StCardImportReadResultV1 = Static<typeof StCardImportReadResultV1Schema>;
export type ReviewStCardImportCommandV1 = Static<typeof ReviewStCardImportCommandV1Schema>;
export type StCardImportReviewResultV1 = Static<typeof StCardImportReviewResultV1Schema>;
export type ConfirmStCardImportCommandV1 = Static<typeof ConfirmStCardImportCommandV1Schema>;
export type StCardImportConfirmResultV1 = Static<typeof StCardImportConfirmResultV1Schema>;
export type StCardImportDispositionCountsV1 = Static<typeof StCardImportDispositionCountsV1Schema>;
export type StCardImportHistoryEntryV1 = Static<typeof StCardImportHistoryEntryV1Schema>;
export type StCardImportHistoryV1 = Static<typeof StCardImportHistoryV1Schema>;
export type TavernBrowserOperationV1 = Static<typeof TavernBrowserOperationV1Schema>;
export type TavernStateEventStreamV1 = Static<typeof TavernStateEventStreamV1Schema>;
export type TavernBrowserNavigationItemIdV1 = Static<typeof NavigationItemId>;
export type SubmitMessageCommandV1 = Static<typeof SubmitMessageCommandV1Schema>;
export type SwipeSelectCommandV1 = Static<typeof SwipeSelectCommandV1Schema>;
export type SwipeSelectResultV1 = Static<typeof SwipeSelectResultV1Schema>;
export type SwipeRemoveCommandV1 = Static<typeof SwipeRemoveCommandV1Schema>;
export type RegenerateMessageCommandV1 = Static<typeof RegenerateMessageCommandV1Schema>;
export type RewindChatCommandV1 = Static<typeof RewindChatCommandV1Schema>;
export type RewindChatResultV1 = Static<typeof RewindChatResultV1Schema>;
export type EditMessageCommandV1 = Static<typeof EditMessageCommandV1Schema>;
export type EditMessageResultV1 = Static<typeof EditMessageResultV1Schema>;
export type DeleteMessageCommandV1 = Static<typeof DeleteMessageCommandV1Schema>;
export type DeleteMessageResultV1 = Static<typeof DeleteMessageResultV1Schema>;
export type BrowserOpeningVariantV1 = Static<typeof BrowserOpeningVariantV1Schema>;
export type ChatOpeningCommandV1 = Static<typeof ChatOpeningCommandV1Schema>;
export type ChatOpeningResultV1 = Static<typeof ChatOpeningResultV1Schema>;
export type CreateChatCommandV1 = Static<typeof CreateChatCommandV1Schema>;
export type ChatCreateResultV1 = Static<typeof ChatCreateResultV1Schema>;
export type SelectChatCommandV1 = Static<typeof SelectChatCommandV1Schema>;
export type ChatSelectResultV1 = Static<typeof ChatSelectResultV1Schema>;
export type MessageSubmissionStatusQueryV1 = Static<typeof MessageSubmissionStatusQueryV1Schema>;
export type MessageSubmissionStatusV1 = Static<typeof MessageSubmissionStatusV1Schema>;
export type CancelTurnCommandV1 = Static<typeof CancelTurnCommandV1Schema>;
export type CancelTurnResultV1 = Static<typeof CancelTurnResultV1Schema>;
export type ChatListQueryV1 = Static<typeof ChatListQueryV1Schema>;
export type ChatListEntryV1 = Static<typeof ChatListEntryV1Schema>;
export type ChatListV1 = Static<typeof ChatListV1Schema>;
export type RenameChatTitleCommandV1 = Static<typeof RenameChatTitleCommandV1Schema>;
export type ChatTitleV1 = Static<typeof ChatTitleV1Schema>;
export type MemoryItemV1 = Static<typeof MemoryItemV1Schema>;
export type MemoryChapterV1 = Static<typeof MemoryChapterV1Schema>;
export type MemoryMutationCommandV1 = Static<typeof MemoryMutationCommandV1Schema>;
export type MemoryMutationResultV1 = Static<typeof MemoryMutationResultV1Schema>;
export type WorldInfoStateV1 = Static<typeof WorldInfoStateV1Schema>;
export type SetWorldInfoBindingCommandV1 = Static<typeof SetWorldInfoBindingCommandV1Schema>;
export type WorldInfoEntryV1 = Static<typeof WorldInfoEntryV1Schema>;
export type WorldInfoItemV1 = Static<typeof WorldInfoItemV1Schema>;
export type WorldInfoItemCommandV1 = Static<typeof WorldInfoItemCommandV1Schema>;
export type WorldInfoCreateCommandV1 = Static<typeof WorldInfoCreateCommandV1Schema>;
export type WorldInfoUpdateCommandV1 = Static<typeof WorldInfoUpdateCommandV1Schema>;
export type WorldInfoImportCommandV1 = Static<typeof WorldInfoImportCommandV1Schema>;
export type ChatExportCommandV1 = Static<typeof ChatExportQueryV1Schema>;
export type ChatExportDispositionV1 = Static<typeof ChatExportDispositionV1Schema>;
/**
 * The export's own wire type is HAND-WRITTEN rather than `Static` of its schema, for the same reason
 * the world book's is: the producer freezes the disposition list, so the type says `readonly` rather
 * than describe a mutable array it never returns. The schema stays the validator the dispatcher
 * checks every reply against.
 */
export type ChatExportV1 = Readonly<{
  apiVersion: typeof TAVERN_BROWSER_API_VERSION;
  format: "tavern-interchange/v1";
  chatHandle: string;
  messageCount: number;
  dispositions: readonly ChatExportDispositionV1[];
  canonicalHash: string;
  jsonl: string;
}>;
export type CompanionListEntryV1 = Static<typeof CompanionListEntryV1Schema>;
export type CompanionListV1 = Static<typeof CompanionListV1Schema>;
export type DeleteCompanionCommandV1 = Static<typeof DeleteCompanionCommandV1Schema>;
export type CompanionDeletionV1 = Static<typeof CompanionDeletionV1Schema>;
export type CompanionDetailV1 = Static<typeof CompanionDetailV1Schema>;
/**
 * The world book's own wire types are HAND-WRITTEN rather than `Static` of their schemas,
 * for the same reason `MemoryReadV1` and `CompanionProfileV1` are: the producer freezes
 * every list it carries and every trigger list inside them, so the type has to say
 * `readonly` rather than describe a mutable array the producer never returns. The schemas
 * (`CompanionWorldBookEntryV1Schema`, `CompanionWorldBookV1Schema`) remain the validators
 * the dispatcher checks every reply against, so the two are one declaration of the same
 * shape at the two layers that need it.
 */
export type CompanionWorldBookEntryV1 = Readonly<{
  title: string;
  keys: readonly string[];
  constant: boolean;
  content: string;
}>;
export type CompanionWorldBookV1 = Readonly<{
  apiVersion: typeof TAVERN_BROWSER_API_VERSION;
  present: boolean;
  /** The durable book's own revision, null in exactly the one case `present` is false. */
  revision: number | null;
  entries: readonly CompanionWorldBookEntryV1[];
}>;
export type UpdateCompanionWorldBookCommandV1 = Readonly<{
  apiVersion: typeof TAVERN_BROWSER_API_VERSION;
  expectedRevision: number;
  /** The projection's own entry shape, so the browser may send back exactly what it read. */
  entries: readonly CompanionWorldBookEntryV1[];
}>;
export type CompanionCharacterVoiceV1 = Static<typeof CompanionCharacterVoiceV1Schema>;
export type CompanionVoiceV1 = Static<typeof CompanionVoiceV1Schema>;
export type UpdateCompanionVoiceCommandV1 = Static<typeof UpdateCompanionVoiceCommandV1Schema>;
export type CreateCompanionCommandV1 = Static<typeof CreateCompanionCommandV1Schema>;
export type PersonaV1 = Static<typeof PersonaV1Schema>;
export type PersonaUpdateCommandV1 = Static<typeof PersonaUpdateCommandV1Schema>;
export type ScenarioV1 = Static<typeof ScenarioV1Schema>;
export type ScenarioUpdateCommandV1 = Static<typeof ScenarioUpdateCommandV1Schema>;
export type GreetingV1 = Static<typeof GreetingV1Schema>;
export type GreetingUpdateCommandV1 = Static<typeof GreetingUpdateCommandV1Schema>;
export type ChatRetentionCommandV1 = Static<typeof ChatRetentionCommandV1Schema>;
export type ChatRetentionResultV1 = Static<typeof ChatRetentionResultV1Schema>;
export type MemoryReadV1 = Readonly<{
  apiVersion: typeof TAVERN_BROWSER_API_VERSION;
  projectionRevision: string;
  memories: readonly MemoryItemV1[];
}>;
/**
 * The character inspector's projection, hand-written for the same reason
 * `MemoryReadV1` is: the projection freezes every list it carries, so the type
 * has to say `readonly` rather than describe a mutable array the producer never
 * returns. The schema (`CompanionProfileV1Schema`) is still the validator the
 * dispatcher checks the reply against, so the two are one declaration of the same
 * shape at the two layers that need it.
 */
export type CompanionProfileV1 = Readonly<{
  apiVersion: typeof TAVERN_BROWSER_API_VERSION;
  name: string;
  /** Her own `companion.json` revision, the value `companion.delete` CASes on. */
  revision: number | null;
  persona: Readonly<{
    present: boolean;
    core: string | null;
    interactionStyle: string | null;
    expressionStyle: string | null;
  }>;
  scenario: Readonly<{ present: boolean; name: string | null; description: string | null }>;
  greetings: Readonly<{
    present: boolean;
    label: string | null;
    variants: readonly Readonly<{ label: string | null; text: string }>[];
  }>;
  worldBook: CompanionWorldBookV1;
}>;
/** One companion's records as a standard Tavern V3 card, plus how to save it. */
export type CompanionCardExportV1 = Static<typeof CompanionCardExportV1Schema>;
export type CompanionAvatarUploadCommandV1 = Static<typeof CompanionAvatarUploadCommandV1Schema>;
export type CompanionAvatarV1 = Static<typeof CompanionAvatarV1Schema>;
export type TavernConnectionSetupFieldV1 = Static<typeof TavernConnectionSetupFieldV1Schema>;
export type TavernConnectionApiShapeV1 = Static<typeof TavernConnectionApiShapeV1Schema>;
export type TavernConnectionThinkingLevelV1 = Static<typeof TavernConnectionThinkingLevelV1Schema>;
export type TavernConnectionModelV1 = Static<typeof TavernConnectionModelV1Schema>;
export type TavernConnectionProviderV1 = Static<typeof TavernConnectionProviderV1Schema>;
export type TavernConnectionV1 = Static<typeof TavernConnectionV1Schema>;
export type TavernConnectionActiveV1 = Static<typeof TavernConnectionActiveV1Schema>;
export type TavernConnectionStateV1 = Static<typeof TavernConnectionStateV1Schema>;
export type TavernConnectionReadV1 = Static<typeof TavernConnectionReadV1Schema>;
export type TavernConnectionCreateCommandV1 = Static<typeof TavernConnectionCreateCommandV1Schema>;
export type TavernConnectionRevisionCommandV1 = Static<typeof TavernConnectionRevisionCommandV1Schema>;
export type TavernConnectionModelCommandV1 = Static<typeof TavernConnectionModelCommandV1Schema>;
export type TavernConnectionProbeV1 = Static<typeof TavernConnectionProbeV1Schema>;
export type TavernRecommendedModelV1 = Static<typeof TavernRecommendedModelV1Schema>;
export type TavernModelProfileV1 = Static<typeof TavernModelProfileV1Schema>;
export type TavernModelProfilesV1 = Static<typeof TavernModelProfilesV1Schema>;
export type TavernModelProfileUpdateCommandV1 = Static<typeof TavernModelProfileUpdateCommandV1Schema>;
export type TavernProblemV1 = Static<typeof TavernProblemV1Schema>;
export type BrowserEventV1 = Static<typeof BrowserEventV1Schema>;
export type TavernBrowserOperationIdV1 = Static<typeof OperationId>;
export type TavernBrowserRouteIdV1 = (typeof RouteDescriptors)[number]["routeId"];
export type TavernReleaseTierV1 = "chat_core" | "tavern_management";

const contractDeclaredRouteIds = new Set<TavernBrowserRouteIdV1>(RouteDescriptors.map((entry) => entry.routeId));
const routeIdByOperationId = new Map<TavernBrowserOperationIdV1, TavernBrowserRouteIdV1>(
  RouteDescriptors.flatMap((entry) => {
    const operationId = (entry as { readonly operationId?: TavernBrowserOperationIdV1 }).operationId;
    return operationId === undefined ? [] : [[operationId, entry.routeId]];
  }),
);
const routeBoundOperationIds = new Set(routeIdByOperationId.keys());
const contractDeclaredNavigationItemIds = new Set<TavernBrowserNavigationItemIdV1>(["chat", "memory", "characters"]);
export type ComposedTavernProfile = Readonly<{
  readonly profileId: string;
  readonly releaseTier: TavernReleaseTierV1;
  readonly routeIds: readonly TavernBrowserRouteIdV1[];
  readonly operationIds: readonly TavernBrowserOperationIdV1[];
  readonly navigationItemIds: readonly TavernBrowserNavigationItemIdV1[];
}>;
/**
 * Module-private identity registry: only the frozen capability slice minted and
 * returned by `composeTavernProfile` is branded here. A structural clone of a
 * composed profile (including an `Object.freeze` spread copy) is not a composed
 * capability slice and must fail before any durable I/O.
 */
const composedTavernProfiles = new WeakSet<object>();
export function composeTavernProfile(input: unknown): ComposedTavernProfile {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    throw new TypeError("Tavern profile must be a plain object");
  const value = input as Record<string, unknown>;
  const expectedKeys = ["profileId", "releaseTier", "routeIds", "operationIds", "navigationItemIds"] as const;
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => {
      const descriptor = descriptors[key];
      return (
        keys.includes(key) &&
        descriptor !== undefined &&
        descriptor.enumerable === true &&
        descriptor.configurable === true &&
        descriptor.writable === true &&
        "value" in descriptor
      );
    })
  )
    throw new TypeError("Tavern profile input is not a capability slice");
  if (typeof value.profileId !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(value.profileId))
    throw new TypeError("Tavern profile id is invalid");
  if (value.releaseTier !== "chat_core" && value.releaseTier !== "tavern_management")
    throw new TypeError("Tavern release tier is invalid");
  if (!Array.isArray(value.routeIds) || value.routeIds.length > 100) throw new TypeError("Tavern routes are invalid");
  if (!Array.isArray(value.operationIds) || value.operationIds.length > 100)
    throw new TypeError("Tavern operations are invalid");
  if (!Array.isArray(value.navigationItemIds) || value.navigationItemIds.length > 100)
    throw new TypeError("Tavern navigation items are invalid");
  const seenRouteIds = new Set<string>();
  for (const routeId of value.routeIds) {
    if (typeof routeId !== "string" || !contractDeclaredRouteIds.has(routeId as TavernBrowserRouteIdV1))
      throw new TypeError("Tavern route is not declared by the contract");
    if (seenRouteIds.has(routeId)) throw new TypeError("Tavern route is duplicated");
    seenRouteIds.add(routeId);
  }
  const seenOperationIds = new Set<string>();
  for (const operationId of value.operationIds) {
    if (typeof operationId !== "string" || !routeBoundOperationIds.has(operationId as TavernBrowserOperationIdV1))
      throw new TypeError("Tavern operation is not bound to a route");
    if (seenOperationIds.has(operationId)) throw new TypeError("Tavern operation is duplicated");
    seenOperationIds.add(operationId);
  }
  for (const operationId of seenOperationIds) {
    const routeId = routeIdByOperationId.get(operationId as TavernBrowserOperationIdV1)!;
    if (!seenRouteIds.has(routeId)) throw new TypeError("Tavern operation route is unavailable in the profile");
  }
  for (const routeId of seenRouteIds) {
    const operationId = (
      RouteDescriptors.find((entry) => entry.routeId === routeId) as
        | { readonly operationId?: TavernBrowserOperationIdV1 }
        | undefined
    )?.operationId;
    if (operationId !== undefined && !seenOperationIds.has(operationId))
      throw new TypeError("Tavern route operation is unavailable in the profile");
  }
  const seenNavigationItemIds = new Set<string>();
  for (const navigationItemId of value.navigationItemIds) {
    if (
      typeof navigationItemId !== "string" ||
      !contractDeclaredNavigationItemIds.has(navigationItemId as TavernBrowserNavigationItemIdV1)
    )
      throw new TypeError("Tavern navigation item is not declared by the contract");
    if (seenNavigationItemIds.has(navigationItemId)) throw new TypeError("Tavern navigation item is duplicated");
    seenNavigationItemIds.add(navigationItemId);
  }
  const profile = Object.freeze({
    profileId: value.profileId,
    releaseTier: value.releaseTier,
    routeIds: Object.freeze([...value.routeIds] as TavernBrowserRouteIdV1[]),
    operationIds: Object.freeze([...value.operationIds] as TavernBrowserOperationIdV1[]),
    navigationItemIds: Object.freeze([...value.navigationItemIds] as TavernBrowserNavigationItemIdV1[]),
  });
  composedTavernProfiles.add(profile);
  return profile;
}

/**
 * Identity-brand type guard: true only for the exact frozen object returned by
 * `composeTavernProfile` (plus actual route/operation membership checks that the
 * binding service performs separately). Structural clones are never branded.
 */
export function isComposedTavernProfile(value: unknown): value is ComposedTavernProfile {
  return typeof value === "object" && value !== null && composedTavernProfiles.has(value);
}

const REFERENCE_TAVERN_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline";
const REFERENCE_TAVERN_RELEASE_TIER = "chat_core" as const;
const REFERENCE_TAVERN_ROUTE_IDS = [
  "bootstrap",
  "state.read",
  "draft.read",
  "chat.submit",
  "chat.cancel",
  "chat.submission_status",
  "events",
] as const;
/**
 * The optional message-mutation extension of the reference Chat profile: Swipe, Swipe variant
 * removal, Regenerate, Rewind, Edit and Delete.
 *
 * The browser client posts all five from its own message controls, so the dispatcher mounted on the
 * composed Chat surface must reach them or the player's controls answer 404. They are routes, not
 * operations: the browser gates Regenerate on the `chat.submit` affordance and Swipe/Rewind/Edit/Delete
 * on the message's own projection, so the Host projects no `state.operations` row for any of them.
 *
 * Declared as an optional group rather than folded into the core list so every existing reference
 * profile - the standalone handler's own declaration and the API-level test slices - stays a valid
 * capability slice, while the one production profile declares the extension. Every route a profile
 * declares must belong to exactly one group, which `referenceTavernProfileFitsCanonicalGroups`
 * enforces.
 */
const REFERENCE_TAVERN_MESSAGE_MUTATION_ROUTE_IDS = [
  "chat.swipe",
  "chat.swipe.remove",
  "chat.regenerate",
  "chat.rewind",
  "chat.edit",
  "chat.delete",
] as const;
const REFERENCE_TAVERN_ROUTE_GROUPS = [
  REFERENCE_TAVERN_ROUTE_IDS,
  REFERENCE_TAVERN_MESSAGE_MUTATION_ROUTE_IDS,
] as const;
const REFERENCE_TAVERN_OPERATION_IDS = ["chat.submit", "chat.cancel"] as const;
const REFERENCE_TAVERN_NAVIGATION_ITEM_IDS = ["chat"] as const;

/**
 * The one reference Chat capability slice of `tavern_browser_api/v1` (release tier `chat_core`): the
 * core routes plus the message-mutation extension. Declared next to the route descriptors it selects,
 * so the routes the dispatcher serves and the routes the profile advertises cannot drift apart.
 */
export function composeReferenceTavernProfile(): ComposedTavernProfile {
  return composeTavernProfile({
    profileId: REFERENCE_TAVERN_PROFILE_ID,
    releaseTier: REFERENCE_TAVERN_RELEASE_TIER,
    routeIds: [...REFERENCE_TAVERN_ROUTE_IDS, ...REFERENCE_TAVERN_MESSAGE_MUTATION_ROUTE_IDS],
    operationIds: REFERENCE_TAVERN_OPERATION_IDS,
    navigationItemIds: REFERENCE_TAVERN_NAVIGATION_ITEM_IDS,
  });
}

/**
 * The canonical-group verdict for one reference Chat profile declaration: the exact identity, the
 * operation/navigation projections, and the route slice a reference dispatcher can serve - the
 * required core routes plus any subset of the optional extension groups, always in the declared
 * order. Exported so the composed-browser contract and a test can hold a declaration against these
 * groups without mounting the surface.
 */
export function referenceTavernProfileFitsCanonicalGroups(profile: ComposedTavernProfile): boolean {
  return (
    profile.profileId === REFERENCE_TAVERN_PROFILE_ID &&
    profile.releaseTier === REFERENCE_TAVERN_RELEASE_TIER &&
    sameOrderedValues(profile.operationIds, REFERENCE_TAVERN_OPERATION_IDS) &&
    sameOrderedValues(profile.navigationItemIds, REFERENCE_TAVERN_NAVIGATION_ITEM_IDS) &&
    isCanonicalGroupSelection(profile.routeIds, REFERENCE_TAVERN_ROUTE_GROUPS, REFERENCE_TAVERN_ROUTE_IDS)
  );
}

/**
 * True when `values` is exactly the required group plus any subset of the optional groups that
 * follow it, always in the declared order. A group is all-or-nothing: a partially declared group is
 * a capability the profile claims but the mounted dispatcher cannot serve. Ordering is part of the
 * check, so a reordered profile is a different capability slice; a route that belongs to no group
 * makes `expected` shorter than `values` and is rejected too.
 */
function isCanonicalGroupSelection(
  values: readonly string[],
  groups: readonly (readonly string[])[],
  required: readonly string[],
): boolean {
  const expected: string[] = [];
  for (const group of groups) {
    const present = group === required || values.some((value) => group.includes(value));
    if (!present) continue;
    if (!group.every((entry) => values.includes(entry))) return false;
    expected.push(...group);
  }
  return expected.length === values.length && expected.every((entry, index) => entry === values[index]);
}

function sameOrderedValues(values: readonly string[], expected: readonly string[]): boolean {
  return values.length === expected.length && values.every((value, index) => value === expected[index]);
}

/**
 * The `tavern_browser_api/v1` reservation ledger: every declared member of this contract
 * that no producer can emit, with the shipped source that serves the shell in its place
 * (`servedBy`), the declared-and-produced member that answers the request instead
 * (`instead`), and why the reservation is deliberate (`reason`).
 *
 * It is exported from the contract rather than kept in the gate because
 * `contract-producer-gate` consumes this ledger: a gate that can be satisfied by editing
 * the gate is the same self-certification the ledger exists to stop.
 *
 * Two honest limits, so this is not mistaken for a live-request check. (1) The tavern
 * producer rule proves a member is NAMED by a module the composed shell mounts as a
 * route server - not that a request to that member is answered end to end. (2) The
 * turn/memory/card-import members use a value-position rule, because a strict write rule
 * would leave every one of them bare; the game operations are checked the same way.
 */
export type TavernBrowserReservationKindV1 =
  | "tavern-operation"
  | "voice-state"
  | "turn-state"
  | "memory-status"
  | "memory-category"
  | "card-import-classification"
  | "card-import-eligibility";
export type TavernBrowserContractReservationV1 = Readonly<{
  readonly kind: TavernBrowserReservationKindV1;
  readonly member: string;
  readonly servedBy: string;
  readonly instead: string;
  readonly reason: string;
}>;

export const TAVERN_BROWSER_CONTRACT_RESERVATIONS_V1: readonly TavernBrowserContractReservationV1[] = Object.freeze([
  Object.freeze({
    kind: "voice-state",
    member: "unavailable",
    servedBy: "host/src/voice-gateway-client.ts",
    instead: "ready",
    reason:
      "audio capture is out of scope by design: no production path captures audio (no `MediaRecorder`, no `getUserMedia`, no speech-to-text, no audio upload; the Desktop Voice lane is output only), and opening this member would first need all four of a capture component, a bounded Host route carrying audio, a Host speech-to-text action and durable capture state - none of which is built",
  }),
]);

export const TavernBrowserValidatorsV1: Readonly<Record<keyof typeof TavernBrowserContractV1.schemas, Validator>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(TavernBrowserContractV1.schemas).map(([name, schema]) => [name, Compile(schema)]),
    ) as Record<keyof typeof TavernBrowserContractV1.schemas, Validator>,
  );
const fixtureHandle = "QWxhZGRpbjpvcGVuIHNlc2FtZQ";
export const TavernBrowserFixtureV1 = Object.freeze({
  message: (): BrowserMessageV1 =>
    Object.freeze({
      handle: fixtureHandle,
      role: "player",
      text: "Hello from a synthetic fixture.",
      locale: "en",
      order: 1,
      revision: 1,
    }),
  turn: (): BrowserTurnV1 =>
    Object.freeze({ handle: fixtureHandle, state: "queued", projectionRevision: 1, canCancel: true }),
  snapshot: (): TavernStateSnapshotV1 => ({
    apiVersion: 1,
    build: { browserContract: TAVERN_BROWSER_API_V1, profileId: "synthetic.chat-core" },
    csrfToken: fixtureHandle,
    browserSession: { expiresAtMs: 1 },
    operations: [],
    navigation: [],
    selection: null,
    chat: null,
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  }),
});
