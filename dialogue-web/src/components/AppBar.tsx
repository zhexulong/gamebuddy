import type { LucideIcon } from "lucide-react";
import type { Ref } from "react";

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
 */

export type AppBarEntry = Readonly<{
  id: string;
  /** The visible and accessible name; the same string is the tooltip. */
  label: string;
  icon: LucideIcon;
  /** True while this entry's drawer is the open one. */
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
  /** Localized status word: online, or the turn state while one is in flight. */
  statusLabel: string;
  /** `progress` adds the pulsing accent dot a running turn already implies. */
  statusTone?: "idle" | "progress";
  entries: readonly AppBarEntry[];
}>;

export function AppBar({
  brandMark,
  brandLabel,
  companionName,
  statusLabel,
  statusTone = "idle",
  entries,
}: AppBarProps) {
  // The monogram is derived from the name, never a decorative symbol
  // (design/26 §4.1); an unnamed companion falls back to the brand mark.
  const monogram = (companionName.trim().slice(0, 1) || brandMark.slice(0, 1)).toUpperCase();

  return (
    <header className="app-bar">
      <div className="app-bar-brand">
        <span className="app-bar-brand-mark" aria-hidden="true">
          {brandMark}
        </span>
        <span className="app-bar-brand-name">{brandLabel}</span>
      </div>

      <div className="app-bar-companion">
        <span className="avatar avatar-small" aria-hidden="true">
          {monogram}
        </span>
        <span className="app-bar-title">{companionName}</span>
        {/* One polite live region announces the connection/turn status once
            (design/26 §7.3); `role="status"` is that region. */}
        <span className="app-bar-status" role="status">
          <span
            className="status-dot"
            {...(statusTone === "progress" ? { "data-tone": "progress" } : {})}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
      </div>

      <div className="app-bar-actions">
        {entries.map((entry) => {
          const Icon = entry.icon;
          return (
            <button
              key={entry.id}
              ref={entry.ref}
              type="button"
              className={entry.active ? "nav-button active" : "nav-button"}
              aria-label={entry.label}
              aria-expanded={entry.active}
              title={entry.label}
              onClick={entry.onClick}
            >
              <Icon size={18} aria-hidden="true" />
              <span className="nav-label">{entry.label}</span>
            </button>
          );
        })}
      </div>
    </header>
  );
}
