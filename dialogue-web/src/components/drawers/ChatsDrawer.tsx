import { MessageSquare } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import type { Messages } from "../../i18n";
import { ContextDrawer } from "../ContextDrawer";

/**
 * The Chats drawer (design/26 §4.2, §4.3): the management surface opens the
 * Chats panel in the one contextual drawer primitive (focus trap, Escape,
 * backdrop, focus restore).
 *
 * It owns chrome only. The panel body and its read/mutate state machine are
 * `ChatsSurfacePanel`, the same component the composed shell's Chats surface
 * mounts, so the list, the exact rename and the retention transitions exist
 * once for both surfaces.
 */
export function ChatsDrawer({
  isOpen,
  onClose,
  labels,
  restoreFocusTo,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  labels: Messages;
  /** The control that opened the drawer; focus returns here on close. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  if (!isOpen) return null;

  return (
    <ContextDrawer
      title={labels.chats}
      closeLabel={labels.close}
      onClose={onClose}
      testId="chats-drawer"
      icon={MessageSquare}
      {...(restoreFocusTo === undefined ? {} : { restoreFocusTo })}
    >
      {children}
    </ContextDrawer>
  );
}
