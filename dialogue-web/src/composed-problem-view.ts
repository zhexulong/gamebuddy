import { assertNever } from "./assert-never";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  GAME_PROBLEM_CODES,
  type GameProblemCode,
} from "./composed-reference-game-browser-api";
import type { Messages } from "./i18n";
import type { TavernProblemCode } from "./reference-pipeline-api";
import { PROBLEM_CODES, TavernProblemError, TavernProtocolError } from "./reference-pipeline-api";
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
 * and a value neither contract declares reaches the internal-error sentence carrying the code it
 * actually received - a diagnostic for a build that met a Host it does not know, never the normal
 * path.
 *
 * The composed shell serves a second contract, `game_browser_api/v1`
 * (`host/src/game-browser-contract/index.ts`), and the same defect lived there: of its twenty-three
 * codes this module named nine by reusing a tavern sentence, and the rest fell through to a generic
 * one. `GAME_PROBLEM_VIEWS` below is exhaustive over that union for the same reason
 * `PROBLEM_SENTENCES` is over the tavern's - and it also records, per code, whether the code's own
 * meaning is that the command was **refused before it ran** or that the outcome is **unsettled**. The
 * game panel needs that distinction: its per-operation line says "the result is uncertain", which is
 * true after a transport failure and false after `unauthorized`, `game_operation_in_progress` or
 * `idempotency_conflict`, where the Host stated it did not run the command at all.
 */

export type ProblemViewState = Readonly<{ kind: "problem"; title: string; detail: string; step: ProblemStep }>;

/**
 * What the player does next, as the failure's own type.
 *
 * A closed state that names what went wrong and not what to do is the defect this type exists
 * against. Sixty-one tavern refusals and twenty-three game ones shared one sentence pair and, at
 * the card, one button - the read taken again - so `turn_busy`, `session_expired` and
 * `payload_too_large` all offered the same step, and for three of those a re-read cannot help. The
 * step is now part of the sentence, which makes it a compile error to word a refusal without
 * answering it (see `sentence` below).
 *
 * The four kinds are the four true answers, and the card renders each differently:
 *
 *  - `control` - a control the product really has, named by the marker that control already
 *    carries (`problem-retry-read` on this card; `message-delete`, `new-chat`, `game-stop` on the
 *    surface the refusal came from). `elsewhere` is for a control this whole-window card cannot
 *    draw, and `said_as` is the phrase the family's own `detail` must literally contain - so
 *    "the answer is that button over there" is a claim the sentence can be held to, not a comment.
 *  - `outside_surface` - the step is off this page entirely: a saved connection in Settings, a fresh
 *    bootstrap handoff, a fresh GameBuddy. The card says which one.
 *  - `self_heals` - there is nothing to press because the condition ends by itself: the Host
 *    finishes the turn it is on (`host_retries`), the next read shows the state the page is owed
 *    (`next_read`), or the event stream reconnects and catches the page up (`stream_resumes`).
 *  - `no_step` - the intent is refused for good: no control anywhere changes it and nothing will
 *    resolve by waiting. `because` is the reason, and the family's `detail` has to state the
 *    constraint that makes it so (`over_a_ceiling`, `already_true`, `not_this_artifact`).
 *
 * The vocabulary is closed in both directions: the `Record<TavernProblemCode, ProblemSentence>` and
 * `Record<GameProblemCode, GameProblemView>` annotations make a new code a missing answer here, and
 * `tools/check-fail-closed-forward-path.mjs` holds every step's id, phrase and reason to what the
 * product really declares.
 */
export type ProblemStep =
  | Readonly<{ kind: "control"; id: string; elsewhere?: Readonly<{ said_as: string }> }>
  | Readonly<{ kind: "outside_surface"; step: "open_settings" | "retry_bootstrap" | "restart_gamebuddy" }>
  | Readonly<{ kind: "self_heals"; because: "host_retries" | "next_read" | "stream_resumes" }>
  | Readonly<{ kind: "no_step"; because: "over_a_ceiling" | "already_true" | "not_this_artifact" }>;

/**
 * The card's own control: the read the failure came from, taken again.
 *
 * It is the only step this whole-window card can perform, which is why it is a named constant rather
 * than a string at each family. `ProblemView` renders the marker as a literal because the boundary
 * rule forbids shared UI importing this module; `tools/check-fail-closed-forward-path.mjs` holds the
 * two spellings equal, and a rename that misses one is a control no element carries.
 */
export const PROBLEM_RETRY_READ = "problem-retry-read";

const RETRY_READ: ProblemStep = { kind: "control", id: PROBLEM_RETRY_READ };
const RESTART_GAMEBUDDY: ProblemStep = { kind: "outside_surface", step: "restart_gamebuddy" };
/** Waiting is the whole step: the Host is working, and it ends its own work. */
const HOST_RETRIES: ProblemStep = { kind: "self_heals", because: "host_retries" };
/** Nothing is in flight; the page is simply behind, and its next read is the state it is owed. */
const NEXT_READ: ProblemStep = { kind: "self_heals", because: "next_read" };

/**
 * What the card shows for this step: its sentence, or its own control - never both.
 *
 * It is here rather than in `ProblemView` because "which of the four kinds is this, and what does the
 * player read for it" is a fact about the refusal vocabulary; the card is a props-driven primitive in
 * the shared-UI layer and may not import a surface's model.
 *
 * One function returns both facts, because they are one decision: a card that drew its button AND the
 * "that button is elsewhere" sentence would be naming two different steps for the same refusal. The
 * own read is the only control this whole-window card can perform; `control` also names controls it
 * cannot draw (`message-delete`, `new-chat`, `game-stop`), and those get the sentence that says where
 * the step is rather than a button that is not it.
 */
export function problemStepPresentation(
  step: ProblemStep,
  labels: Messages,
): Readonly<{ stepLine: string | null; drawsOwnRead: boolean }> {
  return {
    stepLine: stepSentence(step, labels),
    drawsOwnRead: step.kind === "control" && step.id === PROBLEM_RETRY_READ,
  };
}

/** The sentence for every step the card cannot draw a control for. */
function stepSentence(step: ProblemStep, labels: Messages): string {
  switch (step.kind) {
    case "control":
      // A real control the player can press - on the surface the sentence names, not on this card.
      return labels.problemStepElsewhere;
    case "outside_surface":
      return {
        open_settings: labels.problemStepOpenSettings,
        retry_bootstrap: labels.problemStepRetryBootstrap,
        restart_gamebuddy: labels.problemStepRestartGamebuddy,
      }[step.step];
    case "self_heals":
      return {
        host_retries: labels.problemStepSelfHealsHostRetries,
        next_read: labels.problemStepSelfHealsNextRead,
        stream_resumes: labels.problemStepSelfHealsStreamResumes,
      }[step.because];
    case "no_step":
      return {
        over_a_ceiling: labels.problemStepNoStepOverACeiling,
        already_true: labels.problemStepNoStepAlreadyTrue,
        not_this_artifact: labels.problemStepNoStepNotThisArtifact,
      }[step.because];
    default:
      return assertNever(step);
  }
}

/** One player-facing sentence pair, shared by every code whose fact and next step are the same. */
type ProblemSentence = (labels: Messages) => ProblemViewState;

function sentence(title: string, detail: string, step: ProblemStep): ProblemViewState {
  return { kind: "problem", title, detail, step };
}

// --- Authentication, reconciliation, absent route ---------------------------------------------

/** Codes whose own meaning is "there is no live session behind this request". */
const sessionExpired: ProblemSentence = (labels) =>
  sentence(labels.problemSessionExpiredTitle, labels.problemSessionExpiredDetail, RESTART_GAMEBUDDY);

/** Codes whose own meaning is "the state could not be safely reconciled". */
const reconciliationFailed: ProblemSentence = (labels) =>
  sentence(labels.problemReconciliationFailedTitle, labels.problemReconciliationFailedDetail, RETRY_READ);

/** Codes whose own meaning is "the page asked for a route this build does not serve". */
const routeUnavailable: ProblemSentence = (labels) =>
  sentence(labels.problemRouteUnavailableTitle, labels.problemRouteUnavailableDetail, RESTART_GAMEBUDDY);

// --- The message mutations: one sentence each -------------------------------------------------
//
// A rewind destroys everything after the point it names, an edit changes words the model will answer,
// and a delete removes one message the model reads - so "something went wrong" would leave the player
// unable to tell what happened to the conversation. Each refusal names its own point or its own row.

const chatMessageNotFound: ProblemSentence = (labels) =>
  sentence(labels.problemChatMessageNotFoundTitle, labels.problemChatMessageNotFoundDetail, RETRY_READ);

const chatMessageRevisionConflict: ProblemSentence = (labels) =>
  sentence(labels.problemChatMessageRevisionConflictTitle, labels.problemChatMessageRevisionConflictDetail, RETRY_READ);

const chatRewindOpeningRetained: ProblemSentence = (labels) =>
  sentence(labels.problemChatRewindOpeningRetainedTitle, labels.problemChatRewindOpeningRetainedDetail, {
    kind: "no_step",
    because: "not_this_artifact",
  });

const chatRewindTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemChatRewindTurnActiveTitle, labels.problemChatRewindTurnActiveDetail, HOST_RETRIES);

const chatEditTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemChatEditTurnActiveTitle, labels.problemChatEditTurnActiveDetail, HOST_RETRIES);

const chatDeleteOpeningRetained: ProblemSentence = (labels) =>
  sentence(labels.problemChatDeleteOpeningRetainedTitle, labels.problemChatDeleteOpeningRetainedDetail, {
    kind: "no_step",
    because: "not_this_artifact",
  });

const chatDeleteTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemChatDeleteTurnActiveTitle, labels.problemChatDeleteTurnActiveDetail, HOST_RETRIES);

const chatDeleteBindingUnavailable: ProblemSentence = (labels) =>
  sentence(labels.problemChatDeleteBindingUnavailableTitle, labels.problemChatDeleteBindingUnavailableDetail, {
    kind: "no_step",
    because: "not_this_artifact",
  });

/**
 * Discarding one variant, when it is the last one: the reply would be left with nothing to read, and
 * removing the reply itself is the delete - so the sentence names that other control rather than
 * "could not change the conversation".
 */
const chatSwipeLastVariant: ProblemSentence = (labels) =>
  sentence(labels.problemChatSwipeLastVariantTitle, labels.problemChatSwipeLastVariantDetail, {
    kind: "control",
    id: "message-delete",
    elsewhere: { said_as: "delete the message" },
  });

// --- Ten refusals that say the same thing: what you edited moved first --------------------------
//
// Every one of them is a compare-and-set against something the browser read - the mounted selection,
// the draft, the settings, a companion/persona/scenario/greeting record, her voice directive, her own
// world book, a World Info entry. None of them is a fault: something newer was saved (or the selection
// moved) before this change arrived. The player's next step is the same for all ten, and so is the
// sentence - a stale write is not a busy system, a missing item or an outage.

const revisionConflict: ProblemSentence = (labels) =>
  sentence(labels.problemRevisionConflictTitle, labels.problemRevisionConflictDetail, RETRY_READ);

// --- Four one-at-a-time refusals ----------------------------------------------------------------

/**
 * A turn, a selection change, a dialogue activation or the same request is already in progress.
 */
const stillRunning: ProblemSentence = (labels) =>
  sentence(labels.problemStillRunningTitle, labels.problemStillRunningDetail, HOST_RETRIES);

/**
 * Saving her directive would carry the profile to the Chats that pin it, and one of them is answering.
 * Its own sentence rather than `stillRunning`'s: the next step is not "wait for GameBuddy", it is
 * "save again once the reply finishes", and it is the save that is held, not the reply.
 */
const characterVoiceTurnActive: ProblemSentence = (labels) =>
  sentence(labels.problemCharacterVoiceTurnActiveTitle, labels.problemCharacterVoiceTurnActiveDetail, HOST_RETRIES);

/** A repeat that the Host could not recognise as the same request, so it did not run it twice. */
const repeatNotMatched: ProblemSentence = (labels) =>
  sentence(labels.problemRepeatNotMatchedTitle, labels.problemRepeatNotMatchedDetail, RETRY_READ);

/** Five "the handle names nothing any more" refusals: a companion, connection, Chat, entry, import. */
const noSuchItem: ProblemSentence = (labels) =>
  sentence(labels.problemNoSuchItemTitle, labels.problemNoSuchItemDetail, RETRY_READ);

/** Stopping a turn that had already finished or never started: there was nothing to stop. */
const turnNotRunning: ProblemSentence = (labels) =>
  sentence(labels.problemTurnNotRunningTitle, labels.problemTurnNotRunningDetail, NEXT_READ);

/** The runtime, the presentation path or the store could not be used just now: retry is the answer. */
const serviceUnavailable: ProblemSentence = (labels) =>
  sentence(labels.problemServiceUnavailableTitle, labels.problemServiceUnavailableDetail, RETRY_READ);

/** The live event stream lost its place; the page is behind the authoritative state. */
const streamResyncRequired: ProblemSentence = (labels) =>
  sentence(labels.problemStreamResyncTitle, labels.problemStreamResyncDetail, RETRY_READ);

/** A request this build could not take as it was sent - malformed, or over the body ceiling. */
const requestRejected: ProblemSentence = (labels) =>
  sentence(labels.problemRequestRejectedTitle, labels.problemRequestRejectedDetail, {
    kind: "control",
    id: "composer-send",
    elsewhere: { said_as: "send a smaller one" },
  });

// --- Authored content and the reviewed card import ---------------------------------------------

/** Her authored text (persona/scenario/greeting) is not content the Host can keep as written. */
const authoredContentInvalid: ProblemSentence = (labels) =>
  sentence(labels.problemAuthoredContentInvalidTitle, labels.problemAuthoredContentInvalidDetail, {
    kind: "control",
    id: "persona-editor",
    elsewhere: { said_as: "save again" },
  });

/** The review or the confirm step of an import carried fields the Host cannot accept. */
const importFormInvalid: ProblemSentence = (labels) =>
  sentence(labels.problemImportFormInvalidTitle, labels.problemImportFormInvalidDetail, {
    kind: "control",
    id: "card-import-trigger",
    elsewhere: { said_as: "Start the import again from the file" },
  });

/** The chosen file is not a Tavern character card this Host's import accepts. */
const cardImportRejected: ProblemSentence = (labels) =>
  sentence(labels.problemCardImportRejectedTitle, labels.problemCardImportRejectedDetail, {
    kind: "control",
    id: "card-import-trigger",
    elsewhere: { said_as: "choose it again" },
  });

// --- Her own records: a card, a picture ---------------------------------------------------------

/** The Chat's own file is over the ceiling the export carries, and asking again cannot shrink it. */
const exportTooLarge: ProblemSentence = (labels) =>
  sentence(labels.problemExportTooLargeTitle, labels.problemExportTooLargeDetail, {
    kind: "no_step",
    because: "over_a_ceiling",
  });

/** Her records do not fit a card the import accepts, and retrying cannot shrink them. */
const cardTooLarge: ProblemSentence = (labels) =>
  sentence(labels.problemCardTooLargeTitle, labels.problemCardTooLargeDetail, {
    kind: "no_step",
    because: "over_a_ceiling",
  });

/** A PNG card must carry a picture and she has none; the JSON card carries her records without one. */
const cardImageAbsent: ProblemSentence = (labels) =>
  sentence(labels.problemCardImageAbsentTitle, labels.problemCardImageAbsentDetail, {
    kind: "control",
    id: "companion-card-export-json",
    elsewhere: { said_as: "Export the JSON card instead" },
  });

/** Her picture is over the avatar ceiling or not a complete PNG - either way, choose another file. */
const avatarRejected: ProblemSentence = (labels) =>
  sentence(labels.problemAvatarRejectedTitle, labels.problemAvatarRejectedDetail, {
    kind: "control",
    id: "companion-avatar-choose",
    elsewhere: { said_as: "Choose a smaller, complete PNG" },
  });

/** Her durable record is absent, incomplete or unreadable: a data-integrity fact, not an outage. */
const recordUnreadable: ProblemSentence = (labels) =>
  sentence(labels.problemRecordUnreadableTitle, labels.problemRecordUnreadableDetail, {
    kind: "no_step",
    because: "not_this_artifact",
  });

/**
 * The companion in play cannot be deleted: her Chats are the mounted conversation, so removing
 * her would take the conversation the player is having. It is a state of the deployment, not a
 * fault, and the surface's own control is absent for her for the same reason.
 */
const companionInPlay: ProblemSentence = (labels) =>
  sentence(labels.problemCompanionInPlayTitle, labels.problemCompanionInPlayDetail, {
    kind: "no_step",
    because: "not_this_artifact",
  });

/**
 * Choosing the companion who is already in play is not a switch: there is nothing to record, and
 * the player pressed a row that already states the answer. Its own sentence because the next step
 * is nothing at all - not "try again", not "reload".
 */
const companionAlreadyInPlay: ProblemSentence = (labels) =>
  sentence(labels.problemCompanionAlreadyInPlayTitle, labels.problemCompanionAlreadyInPlayDetail, {
    kind: "no_step",
    because: "already_true",
  });

/**
 * A running Game session owns the companion it started with: the Mod authorizes exactly one
 * companion per durable owner record and the cabin is bound to her, so re-binding a live session
 * is a different operation this product does not have. Stopping the game first is a step the
 * player can take, which is what the sentence names.
 */
const companionSwitchBlockedBySession: ProblemSentence = (labels) =>
  sentence(labels.problemCompanionSwitchSessionTitle, labels.problemCompanionSwitchSessionDetail, {
    kind: "control",
    id: "game-stop",
    elsewhere: { said_as: "Stop the game first" },
  });

// --- The opening a Chat started on --------------------------------------------------------------

/** The opening is sealed: the conversation has messages, so its greeting can no longer change. */
const openingLocked: ProblemSentence = (labels) =>
  sentence(labels.problemOpeningLockedTitle, labels.problemOpeningLockedDetail, {
    kind: "control",
    id: "new-chat",
    elsewhere: { said_as: "Start a new chat" },
  });

/** This Chat's opening is not a reviewed greeting set, so there is no other opening to choose. */
const openingNotReviewable: ProblemSentence = (labels) =>
  sentence(labels.problemOpeningNotReviewableTitle, labels.problemOpeningNotReviewableDetail, {
    kind: "no_step",
    because: "not_this_artifact",
  });

/** The named opening is no longer a member of this Chat's greeting set. */
const openingVariantGone: ProblemSentence = (labels) =>
  sentence(labels.problemOpeningVariantGoneTitle, labels.problemOpeningVariantGoneDetail, RETRY_READ);

// --- Her world book -----------------------------------------------------------------------------

/** She has no world book to replace. */
const worldBookAbsent: ProblemSentence = (labels) =>
  sentence(labels.problemWorldBookAbsentTitle, labels.problemWorldBookAbsentDetail, {
    kind: "control",
    id: "world-book-create",
    elsewhere: { said_as: "Save a new one" },
  });

/** The book was replaced, but the threads pinning the previous revision could not follow it. */
const worldBookBindingPartial: ProblemSentence = (labels) =>
  sentence(labels.problemWorldBookBindingPartialTitle, labels.problemWorldBookBindingPartialDetail, RETRY_READ);

// --- The managed World Info library -------------------------------------------------------------

/** Another entry already holds the title this one was saved under. */
const worldInfoTitleTaken: ProblemSentence = (labels) =>
  sentence(labels.problemWorldInfoTitleTakenTitle, labels.problemWorldInfoTitleTakenDetail, {
    kind: "control",
    id: "world-book-submit",
    elsewhere: { said_as: "save again" },
  });

/** The mounted Chat still reads this entry, so it cannot be deleted out from under it. */
const worldInfoInUse: ProblemSentence = (labels) =>
  sentence(labels.problemWorldInfoInUseTitle, labels.problemWorldInfoInUseDetail, {
    kind: "control",
    id: "world-book-list",
    elsewhere: { said_as: "Untie it from the chat first" },
  });

// --- The player's own connections ----------------------------------------------------------------

/** The connection has not been proven to answer yet, so it cannot become the active one. */
const connectionNotReady: ProblemSentence = (labels) =>
  sentence(labels.problemConnectionNotReadyTitle, labels.problemConnectionNotReadyDetail, {
    kind: "control",
    id: "connection-form",
    elsewhere: { said_as: "Test it" },
  });

/** The connection list moved, or the connection named is the active one and cannot be removed. */
const connectionConflict: ProblemSentence = (labels) =>
  sentence(labels.problemConnectionConflictTitle, labels.problemConnectionConflictDetail, RETRY_READ);

/** As many connections as this Host keeps: one has to go before another can be added. */
const connectionLimitReached: ProblemSentence = (labels) =>
  sentence(labels.problemConnectionLimitReachedTitle, labels.problemConnectionLimitReachedDetail, {
    kind: "control",
    id: "connection-list",
    elsewhere: { said_as: "Remove one" },
  });

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
  character_voice_turn_active: characterVoiceTurnActive,
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
  companion_delete_in_play: companionInPlay,
  companion_switch_already_in_play: companionAlreadyInPlay,
  companion_switch_requires_no_session: companionSwitchBlockedBySession,
  companion_record_unreadable: recordUnreadable,

  chat_opening_locked: openingLocked,
  chat_opening_not_greeting: openingNotReviewable,
  chat_opening_variant_not_found: openingVariantGone,

  chat_message_not_found: chatMessageNotFound,
  chat_message_revision_conflict: chatMessageRevisionConflict,
  chat_swipe_last_variant: chatSwipeLastVariant,
  chat_rewind_opening_retained: chatRewindOpeningRetained,
  chat_rewind_turn_active: chatRewindTurnActive,
  chat_edit_turn_active: chatEditTurnActive,
  chat_delete_opening_retained: chatDeleteOpeningRetained,
  chat_delete_turn_active: chatDeleteTurnActive,
  chat_delete_binding_unavailable: chatDeleteBindingUnavailable,
  chat_export_too_large: exportTooLarge,

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
 * What a game refusal says about the command it answered.
 *
 * `refused` is the Host stating it did **not** carry the command out: the operation did not
 * happen, and the player's next step is the one the sentence names. `unsettled` is the Host saying
 * something went wrong without saying whether the command ran - a stop that may or may not have
 * stopped the game. The distinction is not decoration: the game panel's per-operation line says
 * "the result is uncertain", which is the truth for the second class and a false claim for the
 * first. `game_unavailable` is the one wrapper whose cause carries the meaning, so its sentence is
 * templated on the bounded `stardew_*` cause; `game_runtime_unavailable`,
 * `game_endgame_settlement_unavailable` and `state_unavailable` are unsettled because the Host
 * names a failure whose effect on the command it cannot state.
 */
type GameOutcome = "refused" | "unsettled";

type GameProblemView = Readonly<{
  outcome: GameOutcome;
  sentence: (labels: Messages, cause: string | null) => ProblemViewState;
}>;

/** A game refusal whose words are one catalogue pair, with no cause to name. */
function refused(sentenceOf: ProblemSentence): GameProblemView {
  return { outcome: "refused", sentence: (labels) => sentenceOf(labels) };
}

/** A game refusal whose own sentence states that the command's effect is unknown. */
function unsettled(sentenceOf: ProblemSentence): GameProblemView {
  return { outcome: "unsettled", sentence: (labels) => sentenceOf(labels) };
}

// The facts that need game wording of their own. The pairs above are read here unchanged where the
// fact and the next step are the same on both surfaces (a session that ended, something still
// running); these name a game the chat page is not on, so \"Reload the chat\" would point the player
// at the wrong page.
const gamePrerequisitesMissing: ProblemSentence = (labels) =>
  sentence(labels.gameProblemPrerequisitesMissingTitle, labels.gameProblemPrerequisitesMissingDetail, {
    kind: "control",
    id: "companion-choose",
    elsewhere: { said_as: "Enable companion play" },
  });
const gameCompatibility: ProblemSentence = (labels) =>
  sentence(labels.gameProblemCompatibilityTitle, labels.gameProblemCompatibilityDetail, {
    kind: "control",
    id: "game-start-guide",
    elsewhere: { said_as: "Fix the installation" },
  });
const gameInstanceGone: ProblemSentence = (labels) =>
  sentence(labels.gameProblemInstanceGoneTitle, labels.gameProblemInstanceGoneDetail, RETRY_READ);
const gameAttachmentMoved: ProblemSentence = (labels) =>
  sentence(labels.gameProblemAttachmentMovedTitle, labels.gameProblemAttachmentMovedDetail, RETRY_READ);
const gameNotRepeated: ProblemSentence = (labels) =>
  sentence(labels.gameProblemNotRepeatedTitle, labels.gameProblemNotRepeatedDetail, RETRY_READ);
const gameCabinChoiceStale: ProblemSentence = (labels) =>
  sentence(labels.gameProblemCabinChoiceStaleTitle, labels.gameProblemCabinChoiceStaleDetail, {
    kind: "control",
    id: "cabin-choice-list",
    elsewhere: { said_as: "Read the cabins again" },
  });
const gameHandoffUncertain: ProblemSentence = (labels) =>
  sentence(labels.gameProblemHandoffUncertainTitle, labels.gameProblemHandoffUncertainDetail, HOST_RETRIES);
const gameRuntimeUnavailable: ProblemSentence = (labels) =>
  sentence(labels.gameProblemRuntimeUnavailableTitle, labels.gameProblemRuntimeUnavailableDetail, RETRY_READ);
const gameStorageUnavailable: ProblemSentence = (labels) =>
  sentence(labels.gameProblemStorageUnavailableTitle, labels.gameProblemStorageUnavailableDetail, RETRY_READ);
const gameEndgameSettlement: ProblemSentence = (labels) =>
  sentence(labels.gameProblemEndgameSettlementTitle, labels.gameProblemEndgameSettlementDetail, RETRY_READ);
const gameClosed: ProblemSentence = (labels) =>
  sentence(labels.gameProblemClosedTitle, labels.gameProblemClosedDetail, {
    kind: "control",
    id: "game-activate",
    elsewhere: { said_as: "Open the game again from GameBuddy" },
  });
const gameRequestRejected: ProblemSentence = (labels) =>
  sentence(labels.gameProblemRequestRejectedTitle, labels.gameProblemRequestRejectedDetail, RETRY_READ);
const gameRouteUnavailable: ProblemSentence = (labels) =>
  sentence(labels.gameProblemRouteUnavailableTitle, labels.gameProblemRouteUnavailableDetail, RESTART_GAMEBUDDY);
const gameStateUnavailable: ProblemSentence = (labels) =>
  sentence(labels.gameProblemStateUnavailableTitle, labels.gameProblemStateUnavailableDetail, RETRY_READ);

/**
 * Every member of the game contract's `GameProblemCode` union, and what the player reads for it.
 * The annotation is the exhaustiveness proof, exactly as it is above.
 */
const GAME_PROBLEM_VIEWS: Readonly<Record<GameProblemCode, GameProblemView>> = {
  unauthorized: refused(sessionExpired),
  csrf_failed: refused(sessionExpired),
  invalid_request: refused(gameRequestRejected),
  unsupported_api_version: refused(gameRouteUnavailable),
  profile_operation_unavailable: refused(gameRouteUnavailable),

  idempotency_conflict: refused(gameNotRepeated),
  idempotency_expired: refused(gameNotRepeated),
  idempotency_in_progress: refused(stillRunning),

  game_unavailable: {
    outcome: "unsettled",
    sentence: (labels, cause) =>
      sentence(
        labels.gameProblemUnavailableTitle,
        cause === null
          ? labels.gameProblemUnavailableDetail
          : labels.gameProblemUnavailableCauseDetail.replace("{{cause}}", cause),
        RETRY_READ,
      ),
  },
  game_prerequisites_missing: refused(gamePrerequisitesMissing),
  game_compatibility_error: refused(gameCompatibility),
  game_instance_not_found: refused(gameInstanceGone),
  game_attachment_conflict: refused(gameAttachmentMoved),
  game_operation_in_progress: refused(stillRunning),
  stardew_cabin_choice_stale: refused(gameCabinChoiceStale),
  stardew_manifest_handoff_uncertain: unsettled(gameHandoffUncertain),
  game_runtime_unavailable: unsettled(gameRuntimeUnavailable),
  game_storage_unavailable: refused(gameStorageUnavailable),

  closed: refused(gameClosed),
  malformed_request: refused(gameRequestRejected),
  not_found: refused(gameRouteUnavailable),
  state_unavailable: unsettled(gameStateUnavailable),
  game_endgame_settlement_unavailable: unsettled(gameEndgameSettlement),
  // A settings save that lost the race on the record's revision. The Host states it
  // wrote nothing, so the player's next step is the ordinary stale-edit one: look at
  // what it says now and save again. Same fact and same step as every other settings
  // CAS in the product, which is why it reads the shared sentence.
  stardew_settings_revision_conflict: refused(revisionConflict),
};

/** The codes the game contract declares, for the untyped boundary below the map. */
const DECLARED_GAME_PROBLEM_CODES: ReadonlySet<string> = new Set(GAME_PROBLEM_CODES);

function gameProblemView(code: string): GameProblemView | null {
  return DECLARED_GAME_PROBLEM_CODES.has(code) ? GAME_PROBLEM_VIEWS[code as GameProblemCode] : null;
}

/**
 * The failure line a game command's own refusal earns, or the fact that its outcome is unsettled.
 *
 * A game panel line that says "the result is uncertain" is true only when the Host did not say
 * whether it ran the command. Where the Host named a refusal - `unauthorized`,
 * `game_operation_in_progress`, `idempotency_conflict` - it stated that nothing ran, and the
 * player's own sentence for that refusal is the honest line; the operation's uncertain sentence is
 * the false one. The sentence is the catalogue's `detail`: the panel's line is one sentence, and the
 * title ("Something is still running") has no room above it.
 */
export type GameOperationFailure = Readonly<{ kind: "unsettled" }> | Readonly<{ kind: "refused"; sentence: string }>;

export function gameOperationFailure(error: unknown, labels: Messages): GameOperationFailure {
  if (error instanceof ComposedReferenceGameProblemError) {
    const view = gameProblemView(error.code);
    if (view !== null && view.outcome === "refused")
      return { kind: "refused", sentence: view.sentence(labels, error.causeCode).detail };
  }
  return { kind: "unsettled" };
}

/** The line a failed game command shows: the refusal's own words, or the operation's own sentence. */
export function gameOperationFailureSentence(failure: GameOperationFailure, unsettled: string): string {
  return failure.kind === "refused" ? failure.sentence : unsettled;
}

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
    step: RETRY_READ,
  };
}

/**
 * The sentence a refusal the contract named earns, or `null` when the failure names no code this
 * module has words for. This is the one place both surfaces read the catalogue: the composed chat
 * view renders the whole `ProblemViewState`, and the management mapper (`problemTextWithCode`) takes
 * the `detail`, so a code cannot mean one thing on a chat pane and another in a settings panel.
 */
function namedProblemView(error: unknown, labels: Messages): ProblemViewState | null {
  const code = problemCode(error);

  // A code is read against the union its route belongs to: the same string can mean different
  // things on the two surfaces (`idempotency_conflict` cannot tell a chat page to reload a chat it
  // is not on), so a game refusal is answered by the game map first.
  if (code !== null && error instanceof ComposedReferenceGameProblemError) {
    const view = gameProblemView(code);
    if (view !== null) return view.sentence(labels, error.causeCode);
  }
  if (code !== null && isDeclaredProblemCode(code)) return PROBLEM_SENTENCES[code](labels);
  if (code !== null) {
    const view = gameProblemView(code);
    if (view !== null) return view.sentence(labels, null);
  }
  return null;
}

/**
 * The sentence a named refusal earns, as the single line a panel prints - `null` when the failure
 * names nothing the catalogue has words for. The line is the `detail`: a one-line failure notice has
 * no room for the title above it, exactly as `gameOperationFailure` reads it.
 */
export function declaredProblemSentence(error: unknown, labels: Messages): string | null {
  return namedProblemView(error, labels)?.detail ?? null;
}

/**
 * What a panel tells the player after a refused management call.
 *
 * The sentence for a refusal comes from this module's own catalogue, which is the same one the
 * Chat view words a refusal with: a stale save reads the same way whether the player met it in a
 * world book or in the transcript, and there is one place to fix its words. `base` is the
 * fallback - the caller's own honest sentence for that class of failure - and it is what the
 * player reads when the failure named nothing the catalogue has words for (an unknown code, or an
 * opaque `TavernProtocolError`).
 *
 * This lives here rather than in `management-pipeline-api.ts` because the wire contract must stay
 * dependency-free and React-free (`.dependency-cruiser.dialogue-web.cjs`, `no-contract-imports-components`):
 * a contract that imported a UI module would invert the layer the boundary exists to hold.
 *
 * The code itself is contract vocabulary and never part of the sentence: `(world_info_
 * revision_conflict)` is not something a player can act on. A developer who needs it has
 * `problemCodeFor` in the contract module - for a log line or a `data-*` attribute, never
 * concatenated into text.
 */
export function problemTextWithCode(base: string, error: unknown, labels: Messages): string {
  return declaredProblemSentence(error, labels) ?? base;
}

export function composedProblemView(error: unknown, labels: Messages): ProblemViewState {
  const named = namedProblemView(error, labels);
  if (named !== null) return named;
  if (isRetryableProblem(error)) {
    return {
      kind: "problem",
      title: labels.problemTemporarilyUnavailableTitle,
      detail: labels.problemTemporarilyUnavailableDetail,
      step: RETRY_READ,
    };
  }
  return internalProblem(error, labels);
}
