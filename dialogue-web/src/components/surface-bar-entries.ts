import { Brain, Gamepad2, type LucideIcon, MessagesSquare, ScrollText, Settings, Users } from "lucide-react";
import type { RefObject } from "react";
import {
  CHARACTERS_PANEL,
  CHAT_PANEL,
  CHATS_PANEL,
  GAME_PANEL,
  MEMORY_PANEL,
  PRESETS_PANEL,
  SETTINGS_PANEL,
} from "../composed-surface-route";
import type { Messages } from "../i18n";
import type { AppBarEntry } from "./AppBar";

/**
 * The composed shell's surface switcher as data (design/26 §1, design/104 §2).
 *
 * The bar's entries used to be a hand-written JSX array inside the shell: seven object literals
 * interleaved with a conditional spread, whose only reader was the `AppBar` call and whose only
 * test was whether the rendered bar looked right. The order, the label key and the icon are the
 * entry's own facts and do not need the shell's state to be written down, so they are a table
 * here and the shell supplies the two facts that do move: which surface is showing, and the opener
 * (with its return-focus button) for each.
 */

/** The opener one bar entry fires, with the button a closed drawer returns focus to. */
export type SurfaceEntryOpener = Readonly<{ open: () => void; ref: RefObject<HTMLButtonElement | null> }>;

/**
 * The surfaces the bar offers, in the order they sit in it.
 *
 * `management` marks the surfaces that only exist while a conversation is mounted. The entries
 * before the first one are the leading pair: `fold` keeps exactly those visible on a narrow window
 * and collapses the rest behind one disclosure, so the split is read from this table rather than
 * repeated as a number at the call site.
 */
const SURFACE_ENTRIES = [
  { id: CHAT_PANEL, label: "chatPanel", icon: MessagesSquare, management: false },
  { id: GAME_PANEL, label: "gamePanel", icon: Gamepad2, management: false },
  { id: CHATS_PANEL, label: "chatsPanel", icon: MessagesSquare, management: true },
  { id: CHARACTERS_PANEL, label: "charactersPanel", icon: Users, management: true },
  { id: SETTINGS_PANEL, label: "settingsPanel", icon: Settings, management: true },
  { id: MEMORY_PANEL, label: "memoryPanel", icon: Brain, management: true },
  { id: PRESETS_PANEL, label: "presetsPanel", icon: ScrollText, management: true },
] as const satisfies readonly Readonly<{
  id: string;
  label: keyof Messages;
  icon: LucideIcon;
  management: boolean;
}>[];

/** A surface the bar offers. */
export type SurfacePanel = (typeof SURFACE_ENTRIES)[number]["id"];

/** How many entries the bar keeps visible before it folds the rest behind `More`. */
export const LEADING_SURFACE_COUNT = SURFACE_ENTRIES.filter((entry) => !entry.management).length;

/**
 * The bar's entries for one render.
 *
 * `openers` is keyed by the table's own ids, so a surface listed above without an opener - or an
 * opener for a surface the table does not list - is a type error instead of a control that renders
 * and does nothing.
 */
export function surfaceBarEntries(
  labels: Messages,
  shownSurface: string,
  managementPanelsAvailable: boolean,
  openers: Readonly<Record<SurfacePanel, SurfaceEntryOpener>>,
): readonly AppBarEntry[] {
  return SURFACE_ENTRIES.filter((entry) => !entry.management || managementPanelsAvailable).map((entry) => {
    const opener = openers[entry.id];
    return {
      id: entry.id,
      label: labels[entry.label],
      icon: entry.icon,
      active: shownSurface === entry.id,
      onClick: opener.open,
      ref: opener.ref,
    };
  });
}
