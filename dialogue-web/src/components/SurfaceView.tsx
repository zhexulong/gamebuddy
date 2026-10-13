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
 * to the conversation moves focus back to where the player types.
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
  /** Where focus returns when this surface is replaced; the conversation points it at the composer. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
  children: ReactNode;
}>;

export function SurfaceView({
  title,
  testId,
  icon: Icon,
  className,
  restoreFocusTo,
  children,
}: SurfaceViewProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    return () => {
      restoreFocusTo?.current?.focus();
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
