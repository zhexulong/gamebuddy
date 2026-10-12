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
  onRenamedTitle,
  restoreFocusTo,
}: {
  api: ManagementPipelineApi;
  csrfToken: string;
  labels: Messages;
  selectionGeneration: number;
  currentChatHandle: string;
  onRenamedTitle: () => void;
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
        onRenamedTitle={onRenamedTitle}
      />
    </SurfaceView>
  );
}
