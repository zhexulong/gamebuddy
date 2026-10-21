import type { Messages } from "./i18n";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "./composed-reference-game-browser-api";
import { PROBLEM_CODES, TavernProblemError, TavernProtocolError } from "./reference-pipeline-api";
import type { TavernProblemCode } from "./reference-pipeline-api";
import { ReferencePipelineSessionError } from "./reference-pipeline-session";

/**
 * The one place a failure becomes a player-visible chat problem.
 *
 * Two failures this module exists for. The first: the composed surface used to render EVERY
 * non-retryable error as "the chat state could not be safely reconciled". A 401 with no session, an
 * unknown problem code, a malformed response and a real reconciliation conflict all produced that
 * one sentence, so the text pointed the reader at a consistency fault that did not exist.
 *
 * The second is the opposite error and it was larger: the contract declares a closed `ProblemCode`
 * union (`host/src/tavern/browser-contract/index.ts`), and this module named fourteen of its
 * sixty-one members. Every other member - a stale draft, a busy turn, a picture over the avatar
 * ceiling, a World Info title already in use - is a normal business refusal the player can act on,
 * and it arrived as "GameBuddy reported an internal error", i.e. as a system fault. Naming a code is
 * not telling the player what happened; every member of the union now reaches them as words.
 *
 * Three rules shape the mapping:
 *  - **the map is exhaustive over the union.** `PROBLEM_SENTENCES` is a
 *    `Record<TavernProblemCode, ProblemSentence>`, so a member added to the contract fails the
 *    typecheck here - in the file that owes the player words for it - instead of silently
 *    inheriting the internal-error sentence. `TavernProblemCode` is the browser mirror's own union
 *    (`PROBLEM_CODES`), which `problem-code-gate.test.mjs` (`problem-code.7`) pins to EQUALITY with
 *    the contract union plus the router's transport-only `payload_too_large`: a contract code the
 *    mirror does not learn fails there, and the mirror cannot then grow a code with no sentence
 *    without failing here.
 *  - **the unit is a family, not a code.** Codes that state the same fact and ask the same next step
 *    share one sentence (the ten "this changed while you were editing" refusals, the four "still
 *    running" ones, the five "that is not there any more" ones ...); codes whose meaning differs
 *    keep their own, because a shared sentence that is only true for some of its members is the same
 *    defect one level down.
 *  - **the raw member never reaches the player.** Every sentence is a catalogue string; no code,
 *    cause, path or producer text is rendered.
 *
 * Below the union is the untyped boundary, stated rather than hidden: a code arrives off the wire,
 * and the composed shell also serves `game-browser-contract`, whose own problem union is not a
 * tavern `ProblemCode`. A value the union does not declare keeps the classification this surface
 * already had (an absent game route, a retryable outage) and otherwise reaches the internal-error
 * sentence carrying the code it actually received - a diagnostic for a build that met a Host it does
 * not know, never the normal path.
 */

export type ProblemViewState = Readonly<{ kind: "problem"; title: string; detail: string }>;

/** One player-facing sentence pair, shared by every code whose fact and next step are the same. */
type ProblemSentence = (labels: Messages) => ProblemViewState;

function sentence(title: string, detail: string): ProblemViewState {
  return { kind: "problem", title, detail };
}

// --- Authentication, reconciliation, absent route ---------------------------------------------

/** Codes whose own meaning is "there is no live session behind this request". */
const sessionExpired: ProblemSentence = (labels) =>
  sentence(labels.problemSessionExpiredTitle, labels.problemSessionExpiredDetail);

/** Codes whose own meaning is "the state could not be safely reconciled". */
const reconciliationFailed: ProblemSentence = (labels) =>
  sentence(labels.problemReconciliationFailedTitle, labels.problemReconciliationFailedDetail);

/** Codes whose own meaning is "the page asked for a route this build does not serve". */
const routeUnavailable: ProblemSentence = (labels) =>
  sentence(labels.problemRouteUnavailableTitle, labels.problemRouteUnavailableDetail);

// --- The message mutations: one sentence each -------------------------------------------------
//
// A rewind destroys everything after the point it names, an edit changes words the model will answer,
// and a delete removes one message the model reads - so "something went wrong" would leave the player
// unable to tell what happened to the conversation. Each refusal names its own point or its own row.

const chatMessageNotFound: ProblemSentence = (labels) =>
  sentence(labels.problemChatMessageNotFoundTitle, labels.problemChatMessageNotFoundDetail);

const chatMessageRevisionConflict: ProblemSentence = (labels) =>
  sentence(labels.problemChatMessageRevisionConflictTitle, labels.problemChatMessageRevisionConflictDetail);

const chatRewindOpeningRetained: ProblemSentence = (labels) =>
  sentence(labels.problemChatRewindOpeningRetainedTitle, labels.problemChatRewindOpeningRetainedDetail);

const chatRewindTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemChatRewindTurnActiveTitle, labels.problemChatRewindTurnActiveDetail);

const chatEditNotPlayerMessage: ProblemSentence = (labels) =>
  sentence(labels.problemChatEditNotPlayerMessageTitle, labels.problemChatEditNotPlayerMessageDetail);

const chatEditTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemChatEditTurnActiveTitle, labels.problemChatEditTurnActiveDetail);

const chatDeleteOpeningRetained: ProblemSentence = (labels) =>
  sentence(labels.problemChatDeleteOpeningRetainedTitle, labels.problemChatDeleteOpeningRetainedDetail);

const chatDeleteTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemChatDeleteTurnActiveTitle, labels.problemChatDeleteTurnActiveDetail);

const chatDeleteBindingUnavailable: ProblemSentence = (labels) =>
  sentence(labels.problemChatDeleteBindingUnavailableTitle, labels.problemChatDeleteBindingUnavailableDetail);

// --- Ten refusals that say the same thing: what you edited moved first --------------------------
//
// Every one of them is a compare-and-set against something the browser read - the mounted selection,
// the draft, the settings, a companion/persona/scenario/greeting record, her voice directive, her own
// world book, a World Info entry. None of them is a fault: something newer was saved (or the selection
// moved) before this change arrived. The player's next step is the same for all ten, and so is the
// sentence - a stale write is not a busy system, a missing item or an outage.

const revisionConflict: ProblemSentence = (labels) =>
  sentence(labels.problemRevisionConflictTitle, labels.problemRevisionConflictDetail);

// --- Four one-at-a-time refusals ----------------------------------------------------------------

/** A turn, a selection change, a dialogue activation or the same request is already in progress. */
const stillRunning: ProblemSentence = (labels) =>
  sentence(labels.problemStillRunningTitle, labels.problemStillRunningDetail);

/** A repeat that the Host could not recognise as the same request, so it did not run it twice. */
const repeatNotMatched: ProblemSentence = (labels) =>
  sentence(labels.problemRepeatNotMatchedTitle, labels.problemRepeatNotMatchedDetail);

/** Five "the handle names nothing any more" refusals: a companion, connection, Chat, entry, import. */
const noSuchItem: ProblemSentence = (labels) => sentence(labels.problemNoSuchItemTitle, labels.problemNoSuchItemDetail);

/** Stopping a turn that had already finished or never started: there was nothing to stop. */
const turnNotRunning: ProblemSentence = (labels) =>
  sentence(labels.problemTurnNotRunningTitle, labels.problemTurnNotRunningDetail);

/** The runtime, the presentation path or the store could not be used just now: retry is the answer. */
const serviceUnavailable: ProblemSentence = (labels) =>
  sentence(labels.problemServiceUnavailableTitle, labels.problemServiceUnavailableDetail);

/** The live event stream lost its place; the page is behind the authoritative state. */
const streamResyncRequired: ProblemSentence = (labels) =>
  sentence(labels.problemStreamResyncTitle, labels.problemStreamResyncDetail);

/** A request this build could not take as it was sent - malformed, or over the body ceiling. */
const requestRejected: ProblemSentence = (labels) =>
  sentence(labels.problemRequestRejectedTitle, labels.problemRequestRejectedDetail);

// --- Authored content and the reviewed card import ---------------------------------------------

/** Her authored text (persona/scenario/greeting) is not content the Host can keep as written. */
const authoredContentInvalid: ProblemSentence = (labels) =>
  sentence(labels.problemAuthoredContentInvalidTitle, labels.problemAuthoredContentInvalidDetail);

/** The review or the confirm step of an import carried fields the Host cannot accept. */
const importFormInvalid: ProblemSentence = (labels) =>
  sentence(labels.problemImportFormInvalidTitle, labels.problemImportFormInvalidDetail);

/** The chosen file is not a Tavern character card this Host's import accepts. */
const cardImportRejected: ProblemSentence = (labels) =>
  sentence(labels.problemCardImportRejectedTitle, labels.problemCardImportRejectedDetail);

// --- Her own records: a card, a picture ---------------------------------------------------------

/** Her records do not fit a card the import accepts, and retrying cannot shrink them. */
const cardTooLarge: ProblemSentence = (labels) =>
  sentence(labels.problemCardTooLargeTitle, labels.problemCardTooLargeDetail);

/** A PNG card must carry a picture and she has none; the JSON card carries her records without one. */
const cardImageAbsent: ProblemSentence = (labels) =>
  sentence(labels.problemCardImageAbsentTitle, labels.problemCardImageAbsentDetail);

/** Her picture is over the avatar ceiling or not a complete PNG - either way, choose another file. */
const avatarRejected: ProblemSentence = (labels) =>
  sentence(labels.problemAvatarRejectedTitle, labels.problemAvatarRejectedDetail);

/** Her durable record is absent, incomplete or unreadable: a data-integrity fact, not an outage. */
const recordUnreadable: ProblemSentence = (labels) =>
  sentence(labels.problemRecordUnreadableTitle, labels.problemRecordUnreadableDetail);

// --- The opening a Chat started on --------------------------------------------------------------

/** The opening is sealed: the conversation has messages, so its greeting can no longer change. */
const openingLocked: ProblemSentence = (labels) =>
  sentence(labels.problemOpeningLockedTitle, labels.problemOpeningLockedDetail);

/** This Chat's opening is not a reviewed greeting set, so there is no other opening to choose. */
const openingNotReviewable: ProblemSentence = (labels) =>
  sentence(labels.problemOpeningNotReviewableTitle, labels.problemOpeningNotReviewableDetail);

/** The named opening is no longer a member of this Chat's greeting set. */
const openingVariantGone: ProblemSentence = (labels) =>
  sentence(labels.problemOpeningVariantGoneTitle, labels.problemOpeningVariantGoneDetail);

// --- Her world book -----------------------------------------------------------------------------

/** She has no world book to replace. */
const worldBookAbsent: ProblemSentence = (labels) =>
  sentence(labels.problemWorldBookAbsentTitle, labels.problemWorldBookAbsentDetail);

/** The book was replaced, but the threads pinning the previous revision could not follow it. */
const worldBookBindingPartial: ProblemSentence = (labels) =>
  sentence(labels.problemWorldBookBindingPartialTitle, labels.problemWorldBookBindingPartialDetail);

// --- The managed World Info library -------------------------------------------------------------

/** Another entry already holds the title this one was saved under. */
const worldInfoTitleTaken: ProblemSentence = (labels) =>
  sentence(labels.problemWorldInfoTitleTakenTitle, labels.problemWorldInfoTitleTakenDetail);

/** The mounted Chat still reads this entry, so it cannot be deleted out from under it. */
const worldInfoInUse: ProblemSentence = (labels) =>
  sentence(labels.problemWorldInfoInUseTitle, labels.problemWorldInfoInUseDetail);

// --- The player's own connections ----------------------------------------------------------------

/** The connection has not been proven to answer yet, so it cannot become the active one. */
const connectionNotReady: ProblemSentence = (labels) =>
  sentence(labels.problemConnectionNotReadyTitle, labels.problemConnectionNotReadyDetail);

/** The connection list moved, or the connection named is the active one and cannot be removed. */
const connectionConflict: ProblemSentence = (labels) =>
  sentence(labels.problemConnectionConflictTitle, labels.problemConnectionConflictDetail);

/** As many connections as this Host keeps: one has to go before another can be added. */
const connectionLimitReached: ProblemSentence = (labels) =>
  sentence(labels.problemConnectionLimitReachedTitle, labels.problemConnectionLimitReachedDetail);

/**
 * Every member of the contract's `ProblemCode` union, and the sentence the player reads for it.
 * The annotation is the exhaustiveness proof: a code added to the union is a missing property here.
 */
const PROBLEM_SENTENCES: Readonly<Record<TavernProblemCode, ProblemSentence>> = {
  unauthorized: sessionExpired,
  csrf_failed: sessionExpired,
  state_reconciliation_required: reconciliationFailed,
  unsupported_api_version: routeUnavailable,
  profile_operation_unavailable: routeUnavailable,

  selection_conflict: revisionConflict,
  draft_conflict: revisionConflict,
  settings_revision_conflict: revisionConflict,
  companion_conflict: revisionConflict,
  persona_conflict: revisionConflict,
  scenario_conflict: revisionConflict,
  greeting_conflict: revisionConflict,
  character_voice_conflict: revisionConflict,
  companion_world_book_conflict: revisionConflict,
  world_info_revision_conflict: revisionConflict,

  turn_busy: stillRunning,
  selection_busy: stillRunning,
  dialogue_busy: stillRunning,
  idempotency_in_progress: stillRunning,

  idempotency_conflict: repeatNotMatched,
  idempotency_expired: repeatNotMatched,

  companion_not_found: noSuchItem,
  connection_not_found: noSuchItem,
  chat_not_found: noSuchItem,
  world_info_not_found: noSuchItem,
  character_import_not_found: noSuchItem,

  turn_not_active: turnNotRunning,
  turn_already_terminal: turnNotRunning,

  runtime_unavailable: serviceUnavailable,
  presentation_unavailable: serviceUnavailable,
  storage_unavailable: serviceUnavailable,

  stream_resync_required: streamResyncRequired,
  invalid_request: requestRejected,
  payload_too_large: requestRejected,

  authored_content_invalid: authoredContentInvalid,
  character_import_review_invalid: importFormInvalid,
  character_import_confirm_invalid: importFormInvalid,
  st_card_import_rejected: cardImportRejected,
  companion_card_too_large: cardTooLarge,
  companion_card_image_absent: cardImageAbsent,
  companion_avatar_too_large: avatarRejected,
  companion_avatar_malformed: avatarRejected,
  companion_record_unreadable: recordUnreadable,

  chat_opening_locked: openingLocked,
  chat_opening_not_greeting: openingNotReviewable,
  chat_opening_variant_not_found: openingVariantGone,

  chat_message_not_found: chatMessageNotFound,
  chat_message_revision_conflict: chatMessageRevisionConflict,
  chat_rewind_opening_retained: chatRewindOpeningRetained,
  chat_rewind_turn_active: chatRewindTurnActive,
  chat_edit_not_player_message: chatEditNotPlayerMessage,
  chat_edit_turn_active: chatEditTurnActive,
  chat_delete_opening_retained: chatDeleteOpeningRetained,
  chat_delete_turn_active: chatDeleteTurnActive,
  chat_delete_binding_unavailable: chatDeleteBindingUnavailable,

  companion_world_book_absent: worldBookAbsent,
  companion_world_book_binding_partial: worldBookBindingPartial,

  world_info_already_exists: worldInfoTitleTaken,
  world_info_in_use: worldInfoInUse,

  connection_not_ready: connectionNotReady,
  connection_conflict: connectionConflict,
  connection_limit_reached: connectionLimitReached,
};

/** The codes the wire validator accepts, for the untyped boundary below the map. */
const DECLARED_PROBLEM_CODES: ReadonlySet<string> = new Set(PROBLEM_CODES);

function isDeclaredProblemCode(code: string): code is TavernProblemCode {
  return DECLARED_PROBLEM_CODES.has(code);
}

/**
 * The composed shell also serves `game-browser-contract`, whose own route refusal is not a tavern
 * `ProblemCode` and keeps the absent-route sentence this surface already gave it.
 */
const GAME_ABSENT_ROUTE_PROBLEM_CODES: readonly string[] = ["not_found"];

/** Bounded token shape for every code that may be shown to the player. */
const BOUNDED_PROBLEM_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function problemCode(error: unknown): string | null {
  if (error instanceof ComposedReferenceGameProblemError) return error.code;
  if (error instanceof TavernProblemError) return error.code;
  if (error instanceof ReferencePipelineSessionError) return error.code;
  return null;
}

function isRetryableProblem(error: unknown): boolean {
  return (error instanceof ComposedReferenceGameProblemError || error instanceof TavernProblemError) && error.retryable;
}

/**
 * The code the player would act on: the server's validated problem code, the
 * reducer's own code, or the client's own closed protocol reason. `null` when
 * the failure carries no code at all.
 */
export function observedProblemCode(error: unknown): string | null {
  const code = problemCode(error);
  if (code !== null) return BOUNDED_PROBLEM_TOKEN_PATTERN.test(code) ? code : null;
  if (error instanceof ComposedReferenceGameProtocolError)
    return BOUNDED_PROBLEM_TOKEN_PATTERN.test(error.reason) ? error.reason : null;
  if (error instanceof TavernProtocolError) return "tavern_protocol_error";
  return null;
}

/** The bounded coordinator cause the composed shell reported, when it named one. */
export function observedProblemCause(error: unknown): string | null {
  return error instanceof ComposedReferenceGameProblemError ? error.causeCode : null;
}

function internalProblem(error: unknown, labels: Messages): ProblemViewState {
  const code = observedProblemCode(error) ?? labels.problemInternalErrorNoCode;
  const cause = observedProblemCause(error);
  const template = cause === null ? labels.problemInternalErrorDetail : labels.problemInternalErrorCauseDetail;
  return {
    kind: "problem",
    title: labels.problemInternalErrorTitle,
    detail: template.replace("{{code}}", code).replace("{{cause}}", cause ?? ""),
  };
}

export function composedProblemView(error: unknown, labels: Messages): ProblemViewState {
  const code = problemCode(error);

  if (code !== null && isDeclaredProblemCode(code)) return PROBLEM_SENTENCES[code](labels);

  if (code !== null && GAME_ABSENT_ROUTE_PROBLEM_CODES.includes(code)) {
    return {
      kind: "problem",
      title: labels.problemRouteUnavailableTitle,
      detail: labels.problemRouteUnavailableDetail,
    };
  }
  if (isRetryableProblem(error)) {
    return {
      kind: "problem",
      title: labels.problemTemporarilyUnavailableTitle,
      detail: labels.problemTemporarilyUnavailableDetail,
    };
  }
  return internalProblem(error, labels);
}
