import { MessagesSquare } from "lucide-react";
import type { Messages } from "../i18n";
import type { BrowserMessageV1 } from "../reference-pipeline-api";
import { Composer, type ComposerDraftActions, type ComposerSettingsAction, type VoiceSurfaceStateV1 } from "./Composer";
import { SurfaceView } from "./SurfaceView";
import { Timeline } from "./Timeline";

/**
 * The conversation peer surface: the transcript and the composer band, and
 * nothing else.
 *
 * It is the region's reading flow and writing flow together, so it takes the
 * transcript projection plus the authoring facts its one composer renders -
 * never the shell's view object. The shell keeps the session wiring (the send,
 * stop, swipe, regenerate, opening and draft commands and the state they move);
 * this module names only what the region shows and what it calls to change it.
 */
export function ChatSurface({
  transcript,
  preview,
  companionName,
  companionHandle,
  chatTitle,
  labels,
  pending,
  pendingPlayerMessage,
  notice,
  onSwipe,
  onRegenerate,
  onOpeningVariant,
  value,
  onChange,
  onSend,
  onStop,
  isGenerating,
  canStop,
  disabled,
  voice,
  settingsAction,
  draftActions,
}: {
  transcript: readonly BrowserMessageV1[];
  preview: Readonly<{ turnHandle: string; text: string }> | null;
  companionName: string;
  /** The mounted companion's own roster handle: how her picture is addressed. */
  companionHandle: string | null;
  chatTitle: string | null;
  labels: Messages;
  /** The chat mutation in flight and the message it belongs to, if any. */
  pending: Readonly<{ kind: "swipe" | "regenerate" | "opening"; handle: string }> | null;
  /**
   * The optimistic player message: the text just sent, shown until the authoritative one lands.
   * It is handed to the timeline, which owns the scrolling section - rendering it beside the
   * timeline would put it outside that section, where a long transcript scrolls past an
   * optimistic line that never moves with it.
   */
  pendingPlayerMessage?: Readonly<{ idempotencyKey: string; text: string }> | null;
  /** The one turn-failure line the surface reports, or null for none. */
  notice: string | null;
  onSwipe: (messageHandle: string, direction: "prev" | "next") => void;
  onRegenerate: (messageHandle: string) => void;
  onOpeningVariant: (messageHandle: string, direction: "prev" | "next") => void;
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  /**
   * True only while the Host says the mounted turn can be cancelled. A turn in
   * flight without it is still busy; it is just not the player's to stop.
   */
  canStop: boolean;
  disabled: boolean;
  voice?: VoiceSurfaceStateV1 | null;
  settingsAction: ComposerSettingsAction;
  draftActions: ComposerDraftActions;
}) {
  return (
    <SurfaceView title={labels.chatPanel} testId="chat-surface" icon={MessagesSquare} className="surface-conversation">
      <Timeline
        transcript={transcript}
        preview={preview}
        companionName={companionName}
        companionHandle={companionHandle}
        chatTitle={chatTitle}
        labels={labels}
        pending={pending}
        onSwipe={onSwipe}
        onRegenerate={onRegenerate}
        onOpeningVariant={onOpeningVariant}
        pendingPlayerMessage={pendingPlayerMessage}
      />
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
        isGenerating={isGenerating}
        canStop={canStop}
        disabled={disabled}
        labels={labels}
        voice={voice}
        settingsAction={settingsAction}
        draftActions={draftActions}
      />
    </SurfaceView>
  );
}
