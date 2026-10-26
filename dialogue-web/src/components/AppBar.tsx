import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type Ref } from "react";
import { CompanionAvatar } from "./CompanionAvatar";

/**
 * The shared application bar (design/26 §4.1, design/104 §2).
 *
 * Reading order is the documented one and is the same in every shell:
 * brand mark, active companion with its monogram, the connection/turn status,
 * then the affordances for the contextual panels. It is a single 56 px row
 * (`--appbar-height`) so the conversation below keeps its height.
 *
 * Two deliberate properties:
 *
 * - `entries` is a prop, not a fixed list. Design/26 §1 and §8.1 require a
 *   control to be *absent* rather than presented as a disabled Tavern
 *   lookalike, so a profile that mounts no Chats/Characters/World Info/Settings
 *   panel passes no entry for them instead of a greyed-out button.
 * - The mark and the status text are catalog values, never literals: the entry
 *   is visible at every locale (design/26 §5.1).
 * - `fold` moves the bar's trailing entries into one disclosure on a narrow
 *   window instead of shrinking them. The owner's 400 px strip carries six peers,
 *   which is more control than bar: at that width the rail squeezed the
 *   companion's own name down to a bracket, which is the opposite of the point.
 *   Folding is a viewport behaviour and never a capability change - every entry
 *   keeps its name, its target and its surface, and on a wide window the bar is
 *   exactly the row it always was (`display: contents` makes the wrapper no box
 *   at all, style.css).
 */

export type AppBarEntry = Readonly<{
  id: string;
  /** The visible and accessible name; the same string is the tooltip. */
  label: string;
  icon: LucideIcon;
  /** True while this entry's surface is the one occupying the main region. */
  active: boolean;
  onClick: () => void;
  /** The entry's own button, so a closed drawer can restore focus to it. */
  ref?: Ref<HTMLButtonElement>;
}>;

export type AppBarProps = Readonly<{
  /** The brand monogram, e.g. `GB`. */
  brandMark: string;
  brandLabel: string;
  companionName: string;
  /**
   * The companion's own opaque roster handle, which is also the address of her
   * picture: the same `CompanionAvatar` every other surface draws her with, so a
   * companion who has one is never a letter in the bar while she is a face in the
   * conversation. `null` for a bar with no companion at all.
   */
  companionHandle: string | null;
  /**
   * The digest of the picture the player last gave her, when the shell knows one: the reload key her
   * avatar needs so a new picture appears without a reload (`CompanionAvatar.digest`). The bar is one
   * of the places a player looks right after an upload, so it takes the same fact the roster and the
   * transcript are handed.
   */
  companionDigest?: string;
  /** Localized status word: online, or the turn state while one is in flight. */
  statusLabel: string;
  /** `progress` adds the pulsing accent dot a running turn already implies. */
  statusTone?: "idle" | "progress";
  entries: readonly AppBarEntry[];
  /**
   * Where the bar folds its trailing entries behind one `More` disclosure. The
   * entries from `from` on keep every property they have - same control, same
   * name, same 44 px target - and are only moved inside the panel on a narrow
   * bar, which is what gives the companion block its width back. Absent means
   * the bar never folds, which is the whole bar on a wide window.
   */
  fold?: Readonly<{ from: number; label: string }>;
}>;

export function AppBar({
  brandMark,
  brandLabel,
  companionName,
  companionHandle,
  companionDigest,
  statusLabel,
  statusTone = "idle",
  entries,
  fold,
}: AppBarProps) {
  // The monogram is derived from the name as before (design/26 §4.1): the first
  // character by code point, not by UTF-16 unit, so a name starting with an emoji
  // or an extension-area character is never half a surrogate pair - and an unnamed
  // companion falls back to the brand mark, which is a name this bar already has.
  // `CompanionAvatar` owns the picture-or-monogram choice itself.
  const avatarName = companionName.trim().length === 0 ? brandMark : companionName.trim();

  const foldAt = fold?.from ?? entries.length;
  const visibleEntries = entries.slice(0, foldAt);
  const foldedEntries = entries.slice(foldAt);
  // The disclosure is all the player sees of a folded entry, so it takes the
  // current state of the entry it is hiding: on a 400 px strip four peers are
  // inside it, and a `More` that looked the same on all four would say nothing
  // about which surface is occupying the main region. The trigger carries the
  // `active` presentation only - never `aria-current`, which would claim the
  // disclosure itself is the page - and its own `aria-expanded` is untouched.
  const foldedActive = foldedEntries.some((entry) => entry.active);
  const morePanelId = useId();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);

  // The folded entries are the same peer controls, so the disclosure that holds
  // them is a disclosure and nothing more: Escape closes it and returns focus to
  // the button that opened it, a click outside closes it, nothing is covered and
  // nothing is modal - selecting an entry replaces the surface exactly as a
  // visible entry does.
  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // Escape belongs to this disclosure while it is open: closing the panel
      // must not also step the shell back to the conversation behind it.
      event.stopPropagation();
      setMoreOpen(false);
      moreTriggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (moreRef.current !== null && !moreRef.current.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [moreOpen]);

  const renderEntry = (entry: AppBarEntry) => {
    const Icon = entry.icon;
    return (
      <button
        key={entry.id}
        ref={entry.ref}
        type="button"
        className={entry.active ? "nav-button active" : "nav-button"}
        // `active` is presentation; the selection is stated in `aria-current`.
        // These entries are peers within one addressable set - the URL names the
        // selected surface and Back returns to the previous one (design/104 §2) -
        // which is exactly what `aria-current="page"` marks. Not `aria-selected`,
        // which needs a widget role such as `tab`/`option` a plain button does not
        // have; not `aria-pressed`, a toggle that can be released while exactly one
        // of these can be current; and not `aria-expanded`, which described a drawer
        // opening when selecting a peer surface opens nothing - the surface is
        // replaced.
        aria-current={entry.active ? "page" : undefined}
        aria-label={entry.label}
        title={entry.label}
        onClick={entry.onClick}
      >
        <Icon size={18} aria-hidden="true" />
        <span className="nav-label">{entry.label}</span>
      </button>
    );
  };

  return (
    <header className="app-bar">
      <div className="app-bar-brand">
        <span className="app-bar-brand-mark" aria-hidden="true">
          {brandMark}
        </span>
        <span className="app-bar-brand-name">{brandLabel}</span>
      </div>

      <div className="app-bar-companion">
        <CompanionAvatar handle={companionHandle} name={avatarName} className="avatar-small" digest={companionDigest} />
        <span className="app-bar-title">{companionName}</span>
        {/* One polite live region announces the connection/turn status once
            (design/26 §7.3); `role="status"` is that region. The word is a child
            of its own so a narrow bar can retire the visible copy to the status
            dot (style.css) - and `aria-label` and `title` on the region itself
            name it at every width, so retiring the word never retires the fact
            and "a coloured dot" is never the whole of it. */}
        <span className="app-bar-status" role="status" aria-label={statusLabel} title={statusLabel}>
          <span
            className="status-dot"
            {...(statusTone === "progress" ? { "data-tone": "progress" } : {})}
            aria-hidden="true"
          />
          <span className="app-bar-status-label">{statusLabel}</span>
        </span>
      </div>

      <div className="app-bar-actions">
        {visibleEntries.map(renderEntry)}
        {foldedEntries.length > 0 && (
          // One row of peers on a wide bar; one `More` on a 400 px strip. The
          // panel's entries are the same controls, named the same way, and they
          // leave the strip the width its companion block needs.
          <div className="app-bar-more" ref={moreRef} data-folded-active={foldedActive ? "true" : "false"}>
            <button
              ref={moreTriggerRef}
              type="button"
              className={foldedActive ? "nav-button app-bar-more-trigger active" : "nav-button app-bar-more-trigger"}
              aria-expanded={moreOpen}
              aria-controls={morePanelId}
              aria-label={fold?.label}
              title={fold?.label}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreHorizontal size={18} aria-hidden="true" />
            </button>
            <div className="app-bar-more-menu" id={morePanelId} {...(moreOpen ? { "data-open": "true" as const } : {})}>
              {foldedEntries.map((entry) =>
                renderEntry({
                  ...entry,
                  onClick: () => {
                    setMoreOpen(false);
                    entry.onClick();
                  },
                }),
              )}
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
