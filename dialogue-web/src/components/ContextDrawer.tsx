import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * The one contextual drawer primitive (design/26 §4.2, §7.2; design/104 §2).
 *
 * The shell opens exactly one management panel at a time, anchored to the right
 * at `min(420px, 100vw)` over an animated backdrop. The panel is modal: focus
 * moves to its heading on open, stays inside while it is open, and returns to
 * the entry that opened it on close. Escape and the backdrop close it; Browser
 * Back closes it through the shell's own history entry.
 *
 * Every panel of the composed shell uses this component, so the focus trap, the
 * close affordances and the drawer chrome exist once. It owns mechanics only:
 * the caller owns the heading text, the icon, what is inside, and whether the
 * drawer is open at all.
 */

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ContextDrawerProps = Readonly<{
  /** The drawer heading, which is also the dialog's accessible name. */
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** The control that opened the drawer; focus returns here on close. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  /** Frozen `data-testid` for the panel; the backdrop is `${testId}-backdrop`. */
  testId: string;
  icon: LucideIcon;
  /** Extra class on the panel, for a surface that styles its own drawer. */
  panelClassName?: string;
  /** A drawer-level action row, kept outside the scrollable content. */
  actions?: ReactNode;
  children: ReactNode;
}>;

export function ContextDrawer({
  title,
  closeLabel,
  onClose,
  restoreFocusTo,
  testId,
  icon: Icon,
  panelClassName,
  actions,
  children,
}: ContextDrawerProps) {
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

  const handleKeyDown = (event: { key: string; shiftKey: boolean; preventDefault(): void }): void => {
    if (event.key === "Escape") {
      // Escape belongs to this drawer while it is open: closing it must not also
      // step the shell back to the conversation, or close the surface it was
      // opened from - the same ownership the AppBar's folded disclosure takes.
      event.stopPropagation();
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
        className={panelClassName === undefined ? "context-panel" : `context-panel ${panelClassName}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onKeyDown={handleKeyDown}
      >
        <div className="drawer-header">
          <div className="drawer-title-group">
            <Icon size={20} aria-hidden="true" />
            <h2 id={titleId} ref={headingRef} tabIndex={-1}>
              {title}
            </h2>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title={closeLabel} aria-label={closeLabel}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>
        {actions === undefined ? null : <div className="drawer-actions-bar">{actions}</div>}
        <div className="drawer-content">{children}</div>
      </aside>
    </>
  );
}
