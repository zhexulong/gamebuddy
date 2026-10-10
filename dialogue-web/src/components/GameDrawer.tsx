import { Gamepad2 } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { ContextDrawer } from "./ContextDrawer";

/**
 * The Game drawer of the composed shell (design/26 §4.2; design/104 §2, §6-§8).
 *
 * It is the shared `ContextDrawer` with the Game surface's own icon and frozen
 * test ids, so the drawer mechanics (focus trap, heading focus, Escape,
 * backdrop, focus restore) live in exactly one place for every panel.
 */

export type GameDrawerProps = Readonly<{
  /** The drawer heading, which is also the dialog's accessible name. */
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** The control that opened the drawer; focus returns here on close. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  testId?: string;
  children: ReactNode;
}>;

export function GameDrawer({
  title,
  closeLabel,
  onClose,
  restoreFocusTo,
  testId = "game-drawer",
  children,
}: GameDrawerProps) {
  return (
    <ContextDrawer
      title={title}
      closeLabel={closeLabel}
      onClose={onClose}
      testId={testId}
      icon={Gamepad2}
      panelClassName="composed-game-panel"
      {...(restoreFocusTo === undefined ? {} : { restoreFocusTo })}
    >
      {children}
    </ContextDrawer>
  );
}
