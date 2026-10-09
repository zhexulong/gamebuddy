import { Gamepad2, X } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * The single contextual Game drawer (design/26 §4.2, §7.2; design/104 §2).
 *
 * The composed shell opens exactly one management panel at a time, anchored to
 * the right at `min(420px, 100vw)` over an animated backdrop, and the panel is
 * modal: focus moves to its heading on open, stays inside while it is open, and
 * returns to the entry that opened it on close. Escape and the backdrop close
 * it; Browser Back closes it through the shell's own history entry.
 *
 * It is the same drawer primitive the other surfaces use (`.context-panel`,
 * `.backdrop-overlay`, `.drawer-*`), so the visual system stays in one place.
 * This component owns mechanics only - the caller owns what is inside it, and
 * whether the drawer is open at all.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Opening a panel moves focus to its heading (design/26 §7.2), and closing it
  // gives focus back to the invoking control instead of dropping it on <body>.
  useEffect(() => {
    headingRef.current?.focus();
    return () => {
      restoreFocusTo?.current?.focus();
    };
  }, [restoreFocusTo]);

  const handleKeyDown = (event: {
    key: string;
    shiftKey: boolean;
    preventDefault(): void;
  }): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (panel === null) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
    const first = focusable.at(0);
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (active === null || !panel.contains(active)) {
      event.preventDefault();
      first.focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const titleId = `${testId}-title`;

  return (
    <>
      <div
        className="backdrop-overlay composed-drawer-backdrop"
        onClick={onClose}
        aria-hidden="true"
        data-testid={`${testId}-backdrop`}
      />
      <aside
        ref={panelRef}
        className="context-panel composed-game-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onKeyDown={handleKeyDown}
      >
        <div className="drawer-header">
          <div className="drawer-title-group">
            <Gamepad2 size={20} aria-hidden="true" />
            <h2 id={titleId} ref={headingRef} tabIndex={-1}>
              {title}
            </h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={closeLabel}
            aria-label={closeLabel}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        <div className="drawer-content">{children}</div>
      </aside>
    </>
  );
}
