import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * The composed shell's surface chrome (design/104 §2; design/26 §4).
 *
 * Chat, Chats, Characters, Game, Settings, Memory and World Info are peers: the
 * AppBar selects which one occupies the main region, exactly one is shown at a
 * time, and selecting another replaces it rather than covering it. The
 * conversation is the default surface, not a privileged one - every other surface
 * takes the same main region, which is why none of them is a modal overlay: no
 * backdrop, no focus trap, no dialog role.
 *
 * What the keyboard path still needs: selecting a surface moves focus to its
 * heading (so a keyboard user lands inside the surface they chose), and returning
 * to the conversation moves focus back to where the player types - which the
 * conversation states by naming its own field (`restoreFocusTo`), because a
 * surface cannot put focus on something that its own unmount has already removed.
 *
 * It owns chrome only: the caller owns the heading text, the icon, the surface
 * body, and whether this surface is the selected one at all.
 */

export type SurfaceViewProps = Readonly<{
  /** The surface heading, which is also the region's accessible name. */
  title: string;
  /** Frozen `data-testid` for the surface region. */
  testId: string;
  icon: LucideIcon;
  /** Extra class on the region, for a surface that styles its own layout. */
  className?: string;
  /**
   * Where focus returns when this surface is replaced: the control that selected it.
   *
   * The conversation names its own AppBar entry like every peer, and it cannot name its composer: a
   * passive cleanup runs after the commit that removed the surface's nodes, so the field is already
   * detached when this fires (measured, see the cleanup below). The composer landing on the way BACK is
   * the shell's move, through the field's own ref (`useSurfaceRoute`).
   */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}>;

export function SurfaceView({ title, testId, icon: Icon, className, restoreFocusTo, children }: SurfaceViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    return () => {
      // A caller that wants a keyboard landing place names one, and this hands it back.
      //
      // Two targets can be named and still not be focusable, and neither is a reason to look for a
      // third place to put the focus:
      //
      //  - a folded nav entry lives inside the `More` disclosure, which is `display: none` while it is
      //    closed, and `focus()` on a node that is not rendered does nothing;
      //  - a target inside the surface being replaced is already gone by the time this cleanup runs - a
      //    passive cleanup runs after the commit that removed those nodes (measured: the conversation's
      //    own textarea is no longer in the document here, so `isConnected` is false).
      //
      // So the one fallback is the control that owns the folded group, which is on screen exactly while
      // an entry is folded into it. When the bar has no fold open (`> 480 px`, `style.css`), that trigger
      // is itself `display: none` and this hands focus to nothing: the incoming surface's own mount focus
      // takes over, which is the documented behaviour of a surface switch. That is the refusal, and it is
      // stated here rather than papered over with a second lookup.
      const target = restoreFocusTo?.current;
      if (target !== null && target !== undefined && target.isConnected && target.offsetParent !== null) {
        target.focus();
        return;
      }
      const foldedOwner = document.querySelector<HTMLElement>(".app-bar-more-trigger");
      foldedOwner?.focus();
    };
  }, [restoreFocusTo]);

  const titleId = `${testId}-title`;

  return (
    <section
      className={className === undefined ? "surface-view" : `surface-view ${className}`}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <header className="surface-header">
        <Icon size={20} aria-hidden="true" />
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
      </header>
      <div className="surface-content">{children}</div>
    </section>
  );
}
