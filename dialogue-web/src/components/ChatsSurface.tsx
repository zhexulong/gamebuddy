import { MessagesSquare } from "lucide-react";
import type { RefObject } from "react";
import type { Messages } from "../i18n";
import type { ManagementPipelineApi } from "../management-pipeline-api";
import { ChatsSurfacePanel } from "./management-surface-panels";
import { SurfaceView } from "./SurfaceView";

/**
 * The Chats peer surface: the region, its heading and the saved-chat list with
 * its rename and retention transitions.
 *
 * The panel reads the authoritative list itself; the shell supplies only the
 * mounted selection's generation (every rename and lifecycle CAS carries it),
 * the current chat handle, and the reread that moves the shell's own Chat
 * heading after a rename.
 *
 * It holds no turn state (ADR-0010): selecting another Chat is a focus
 * transfer, so the Host aborts a generating turn itself and the rows stay
 * enabled while one runs.
 */
export function ChatsSurface({
  api,
  csrfToken,
  labels,
  selectionGeneration,
  currentChatHandle,
  selectAvailable,
  onRenamedTitle,
  onChatSwitched,
  onMountedChatChosen,
  onCurrentChatRemoved,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  selectionGeneration: number;
  currentChatHandle: string;
  /** `false` when the mount knows no `chat.select` route is served; the rows are then not selectable. */
  selectAvailable?: boolean;
  onRenamedTitle: () => void;
  /** Fires after the Host committed an in-process switch to another Chat. */
  onChatSwitched?: () => void;
  /**
   * Fires when the player chose the already-mounted Chat: no selection is admitted,
   * but the shell still shows the conversation the row names.
   */
  onMountedChatChosen?: () => void;
  /**
   * Fires after a retention transition removed the mounted Chat from the active
   * list: the shell owns the selection, so it replaces the dead mount itself.
   */
  onCurrentChatRemoved?: (handle: string) => void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView title={labels.chatsPanel} testId="chats-surface" icon={MessagesSquare} restoreFocusTo={restoreFocusTo}>
      <ChatsSurfacePanel
        api={api}
        csrfToken={csrfToken}
        labels={labels}
        selectionGeneration={selectionGeneration}
        currentChatHandle={currentChatHandle}
        {...(selectAvailable === undefined ? {} : { selectAvailable })}
        onRenamedTitle={onRenamedTitle}
        {...(onChatSwitched === undefined ? {} : { onChatSwitched })}
        {...(onMountedChatChosen === undefined ? {} : { onMountedChatChosen })}
        {...(onCurrentChatRemoved === undefined ? {} : { onCurrentChatRemoved })}
      />
    </SurfaceView>
  );
}
