import { MessageSquare } from "lucide-react";
import type { RefObject } from "react";
import type { Messages } from "../i18n";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { armedRows, awaitingFirstWord, replyHasNoModel, isTurnInFlight, type ChatUIState } from "./chat-ui-state";
import { Composer, type ComposerDraftActions, type ComposerSettingsAction, type VoiceSurfaceStateV1 } from "./Composer";
import { SurfaceView } from "./SurfaceView";
import { Timeline } from "./Timeline";

/**
 * The conversation peer surface: the transcript, the composer band, and the one
 * standing fact about them that is not part of either.
 *
 * It is the region's reading flow and writing flow together, so it takes the
 * transcript projection plus the authoring facts its one composer renders -
 * never the shell's view object. The shell keeps the session wiring (the send,
 * stop, swipe, regenerate, opening and draft commands and the state they move),
 * including the model route whose answer is `modelRoute` below;
 * this module names only what the region shows and what it calls to change it.
 */
export function ChatSurface({
  transcript,
  preview,
  companionName,
  companionHandle,
  companionDigest,
  chatTitle,
  labels,
  pending,
  uiState,
  notice,
  arrivalNotice,
  replyTruncated,
  onSwipe,
  onSwipeRemove,
  onSwipeRemoveConfirm,
  onSwipeRemoveCancel,
  onRegenerate,
  onOpeningVariant,
  onActFromHere,
  onActRewind,
  onActFork,
  onActCancel,
  onEdit,
  onDelete,
  onDeleteConfirm,
  onDeleteCancel,
  value,
  onChange,
  onSend,
  onStop,
  onOpenSettings,
  voice,
  settingsAction,
  draftActions,
  composerFieldRef,
  restoreFocusTo,
}: {
  transcript: readonly BrowserMessageV1[];
  preview: Readonly<{ turnHandle: string; text: string }> | null;
  companionName: string;
  /** The mounted companion's own roster handle: how her picture is addressed. */
  companionHandle: string | null;
  /**
   * The digest of the picture the player last gave her, when the shell knows one: her rows' avatar
   * reloads under it, so a picture the player just uploaded is the one on the transcript (see
   * `CompanionAvatar.digest`). Every row here belongs to the one mounted companion, so it is one
   * value rather than a map.
   */
  companionDigest?: string;
  chatTitle: string | null;
  labels: Messages;
  /** The chat mutation in flight and the message it belongs to, if any. */
  pending: Readonly<{
    kind: "swipe" | "swipeRemove" | "regenerate" | "opening" | "rewind" | "edit" | "delete" | "fork";
    handle: string;
  }> | null;
  /**
   * What this conversation is doing, which row each destructive confirmation is open on, and the two
   * facts the composer answers to. One value, derived by `deriveChatUIState`, so no control on this
   * surface is rendered from a flag of its own (see `chat-ui-state`).
   */
  uiState: ChatUIState;
  /** The one turn-failure line the surface reports, or null for none. */
  notice: string | null;
  /**
   * The arrival read that could not finish, or null. It sits apart from `notice` because it is not
   * about the turn: the conversation and the draft on screen are the last state the Host confirmed.
   */
  arrivalNotice?: string | null;
  /**
   * True while the Host says the mounted turn's own generation stopped at the model's length
   * ceiling: the reply it wrote is a prefix, and the sentence about that belongs on that reply's
   * own row rather than in this one failure-or-notice line at the bottom of the surface.
   */
  replyTruncated: boolean;
  onSwipe: (messageHandle: string, direction: "prev" | "next") => void;
  /** The variant discard and its confirmation. */
  onSwipeRemove: (messageHandle: string, targetIndex: number) => void;
  onSwipeRemoveConfirm: (messageHandle: string, targetIndex: number) => void;
  onSwipeRemoveCancel: () => void;
  onRegenerate: (messageHandle: string) => void;
  onOpeningVariant: (messageHandle: string, direction: "prev" | "next") => void;
  /**
   * The one entry a message has for changing what comes after it, and the two answers it opens: a fork
   * (the prefix becomes a second Chat, this conversation keeps everything) and a rewind (the messages
   * after this one are removed).
   */
  onActFromHere: (messageHandle: string, expectedOrder: number) => void;
  onActRewind: (messageHandle: string, expectedOrder: number) => void;
  onActFork: (messageHandle: string) => void;
  onActCancel: () => void;
  /** The player's own row's edit: the new text and the order the page rendered the row at. */
  onEdit: (messageHandle: string, expectedOrder: number, text: string) => void;
  /** The delete point and its confirmation. */
  onDelete: (messageHandle: string, expectedOrder: number) => void;
  onDeleteConfirm: (messageHandle: string, expectedOrder: number) => void;
  onDeleteCancel: () => void;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  /** Opens the Settings surface (the connection section is its first block). */
  onOpenSettings: () => void;
  voice?: VoiceSurfaceStateV1 | null;
  settingsAction: ComposerSettingsAction;
  draftActions: ComposerDraftActions;
  /**
   * The composer's field, when the shell also focuses it: returning to the conversation lands where
   * the player types (`SurfaceView`'s documented promise), and the shell owns that move because it is
   * the only thing that knows the difference between a return and the first paint. Handing it the
   * node is one spelling of that place - a class-name lookup in the shell was the second.
   */
  composerFieldRef?: RefObject<HTMLTextAreaElement | null>;
  /** Where focus returns when this surface is replaced: the AppBar entry that selects it. */
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  const rows = armedRows(uiState);
  /**
   * Her side of the transcript has nothing on it yet: a turn is mounted and no delta of it has painted. `Timeline`
   * draws that window as a row of its own, so "she is working on it" and "it is broken" stop looking the same.
   */
  const awaitingReply = awaitingFirstWord(uiState, preview !== null);
  return (
    <SurfaceView
      title={labels.chatPanel}
      testId="chat-surface"
      icon={MessageSquare}
      className="surface-conversation"
      restoreFocusTo={restoreFocusTo}
    >
      <Timeline
        transcript={transcript}
        preview={preview}
        companionName={companionName}
        companionHandle={companionHandle}
        companionDigest={companionDigest}
        chatTitle={chatTitle}
        labels={labels}
        pending={pending}
        onSwipe={onSwipe}
        onSwipeRemove={onSwipeRemove}
        onSwipeRemoveConfirm={onSwipeRemoveConfirm}
        onSwipeRemoveCancel={onSwipeRemoveCancel}
        swipeRemoveArmedHandle={rows.swipeRemove}
        onRegenerate={onRegenerate}
        onOpeningVariant={onOpeningVariant}
        onActFromHere={onActFromHere}
        onActRewind={onActRewind}
        onActFork={onActFork}
        onActCancel={onActCancel}
        actArmedHandle={rows.fromHere}
        onEdit={onEdit}
        onDelete={onDelete}
        onDeleteConfirm={onDeleteConfirm}
        onDeleteCancel={onDeleteCancel}
        deleteArmedHandle={rows.delete}
        pendingPlayerMessage={uiState.pendingLine}
        replyTruncated={replyTruncated}
        turnInFlight={isTurnInFlight(uiState)}
        awaitingReply={awaitingReply}
      />
      {replyHasNoModel(uiState.send) && (
        // The standing fact, above the one line that reports the last outcome: the Host could not
        // serve the model its own send path resolves, so this reply has nowhere to go. The honest
        // sentence belongs on the surface the player is looking at rather than after a failed send,
        // and it names the one screen where a model is chosen.
        <div className="warning-banner" data-chat-no-model="" role="status">
          <span>{labels.chatNoModelTitle}</span>
          <button type="button" className="small-button" onClick={onOpenSettings}>
            {labels.chatNoModelAction}
          </button>
        </div>
      )}
      {arrivalNotice != null && (
        // The sync that would have shown the Host's current conversation did not finish. What the
        // player is reading stays - it is the last state the Host confirmed, and it is also where
        // their unsent draft lives - so the surface says which read stood instead of replacing it.
        <p className="reference-turn-notice" role="status" data-testid="chat-arrival-notice">
          {arrivalNotice}
        </p>
      )}
      {notice !== null && (
        <p className="reference-turn-notice" role="status">
          {notice}
        </p>
      )}
      {/* The conversation is the reading flow and the writing flow, and nothing
          else: the transcript scrolls above a composer band. This surface's model
          settings are a popout opened from the composer's action row, and the
          durable draft is the composer's own field (the seeding effect fills it),
          so neither is a resident block between the two. */}
      <Composer
        value={value}
        onChange={onChange}
        onSend={onSend}
        onStop={onStop}
        uiState={uiState}
        labels={labels}
        voice={voice}
        settingsAction={settingsAction}
        draftActions={draftActions}
        fieldRef={composerFieldRef}
      />
    </SurfaceView>
  );
}
