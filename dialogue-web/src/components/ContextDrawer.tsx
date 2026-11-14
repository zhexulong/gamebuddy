import { X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";

/**
 * The one contextual drawer primitive (design/26 §4.2, §7.2; design/104 §2).
 *
 * The shell opens exactly one management panel at a time, anchored to the right
 * at `min(420px, 100vw)` over a scrim. The panel is modal, and the modality is the
 * platform's own: this component calls `showModal()` on a native `<dialog>`, so the
 * panel joins the top layer - no ancestor's `transform`, `filter` or
 * `contain: paint` can re-anchor or clip it, and no `z-index` has to outguess one -
 * the page behind becomes inert, the pointer cannot reach it, and Escape closes the
 * drawer wherever focus happens to be.
 *
 * Two behaviours are not the platform's, and they are the only reason this file
 * has a key handler at all:
 *
 *  - **the wrap.** A modal `<dialog>` keeps the page behind out of reach but parks
 *    focus on the browser's own UI when Tab leaves the last control (measured in
 *    this repository's Chromium: `close -> removal -> picture -> <body> -> close`),
 *    while `design/26 §7.2` - and the dialog pattern generally - has Tab from the
 *    last control land on the first. The wrap is the one press the platform does
 *    not provide; containment is no longer this file's job.
 *  - **Escape ownership.** The keydown stops at the drawer so closing it does not
 *    also step the shell back to the conversation, or close the surface it was
 *    opened from. The close itself arrives as the dialog's `cancel` event.
 *
 * The rest is the drawer's own behaviour, kept as it was: focus moves to the
 * heading on open and returns to the entry that opened the drawer on close, the
 * close button closes it, and a press outside the panel closes it.
 *
 * Every panel of the composed shell uses this component, so the modality, the
 * close affordances and the drawer chrome exist once. It owns mechanics only:
 * the caller owns the heading text, the icon, what is inside, and whether the
 * drawer is open at all.
 */

/** The elements that could be a tab stop; which of them ARE is the browser's answer, read in `tabStops`. */
const TAB_CANDIDATE_SELECTOR = "a, button, input, select, textarea, summary, [tabindex]";

/**
 * The stops a Tab press can reach inside the panel, in DOM order, by the browser's own
 * two answers: `tabIndex >= 0` (`tabindex="-1"` is how the avatar section's hidden
 * `<input type="file">` stays programmatically clickable and out of the walk) and
 * `checkVisibility()` (a `<summary>` in a CLOSED `<details>` still has a client rect and
 * the browser will not focus it). The active element is kept even when it fails the
 * second, so a control being focused as the drawer closes still counts.
 */
function tabStops(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(TAB_CANDIDATE_SELECTOR)].filter(
    (element) =>
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      (element === document.activeElement || element.checkVisibility()),
  );
}

export type ContextDrawerProps = Readonly<{
  /** The drawer heading, which is also the dialog's accessible name. */
  title: string;
  closeLabel: string;
  onClose: () => void;
  /** The control that opened the drawer; focus returns here on close. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  /** Frozen `data-testid` for the panel. */
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
  const panelRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // `showModal()` is what makes the panel modal, and it runs before the drawer is
  // painted: until it is called the dialog is `display: none`. Opening a panel then
  // moves focus to its heading (design/26 §7.2), and closing it gives focus back to
  // the invoking control instead of dropping it on <body>.
  useEffect(() => {
    panelRef.current?.showModal();
    headingRef.current?.focus();
    return () => {
      restoreFocusTo?.current?.focus();
    };
  }, [restoreFocusTo]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key === "Escape") {
      // Escape belongs to this drawer while it is open: the shell's own window handler
      // must not also step out of the surface the drawer was opened from. A control
      // inside that answers Escape first has already stopped the key, so one press has
      // one owner - the armed pair closes itself and leaves this drawer open.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const stops = tabStops(event.currentTarget);
    const first = stops.at(0);
    const last = stops.at(-1);
    if (first === undefined || last === undefined) return;
    if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    }
  };

  // The platform raises `cancel` for every Escape while the dialog is modal - including
  // the press an armed pair inside already answered, which it cannot decline. The native
  // close is declined here so this component's own keydown stays the one path; the case
  // that keydown cannot reach is a control that disabled itself mid-interaction, which
  // parks focus on `<body>`, and that press still has to close the drawer.
  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.preventDefault();
    const panel = panelRef.current;
    if (panel !== null && panel.contains(document.activeElement)) return;
    onClose();
  };

  // The same affordance the hand-written scrim carried: a press outside the panel
  // closes it, a press on the panel does not. A press on the platform's `::backdrop`
  // targets the dialog element itself, so the two are told apart by where the pointer
  // is, not by what was hit - a programmatic `.click()` (the avatar section's hidden
  // file input) carries no coordinates and must never read as a press outside.
  const dismissOnOutsidePress = (event: MouseEvent<HTMLDialogElement>): void => {
    if (event.target !== event.currentTarget) return;
    const box = event.currentTarget.getBoundingClientRect();
    const outside =
      event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
    if (outside) onClose();
  };

  const titleId = `${testId}-title`;

  return (
    <dialog
      ref={panelRef}
      className={panelClassName === undefined ? "context-panel" : `context-panel ${panelClassName}`}
      aria-labelledby={titleId}
      data-testid={testId}
      onCancel={handleCancel}
      onClick={dismissOnOutsidePress}
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
    </dialog>
  );
}
