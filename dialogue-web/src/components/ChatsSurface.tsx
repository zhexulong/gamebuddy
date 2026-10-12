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
 */
export function ChatsSurface({
  api,
  csrfToken,
  labels,
  selectionGeneration,
  currentChatHandle,
  selectAvailable,
  turnInFlight,
  onRenamedTitle,
  onChatSwitched,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  selectionGeneration: number;
  currentChatHandle: string;
  /** `false` when the mount knows no `chat.select` route is served; the rows are then not selectable. */
  selectAvailable?: boolean;
  /**
   * `true` while a turn is generating. Switching is turn-level, so the rows are
   * then not selectable and the panel names the reason the player can act on.
   */
  turnInFlight?: boolean;
  onRenamedTitle: () => void;
  /** Fires after the Host committed an in-process switch to another Chat. */
  onChatSwitched?: () => void;
  restoreFocusTo: RefObject<HTMLElement | null>;
}) {
  return (
    <SurfaceView
      title={labels.chatsPanel}
      testId="chats-surface"
      icon={MessagesSquare}
      restoreFocusTo={restoreFocusTo}
    >
      <ChatsSurfacePanel
        api={api}
        csrfToken={csrfToken}
        labels={labels}
        selectionGeneration={selectionGeneration}
        currentChatHandle={currentChatHandle}
        {...(selectAvailable === undefined ? {} : { selectAvailable })}
        {...(turnInFlight === undefined ? {} : { turnInFlight })}
        onRenamedTitle={onRenamedTitle}
        {...(onChatSwitched === undefined ? {} : { onChatSwitched })}
      />
    </SurfaceView>
  );
}
