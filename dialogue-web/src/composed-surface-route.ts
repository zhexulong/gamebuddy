import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * The single contextual panel this profile can open (design/26 §4.2). The open
 * panel is part of the URL, so a refresh restores it and Browser Back closes it
 * before it leaves the chat (design/26 §7.2, design/104 §2).
 */
export const PANEL_PARAM = "panel";
export const CHAT_PANEL = "chat" as const;
export const GAME_PANEL = "game" as const;
export const CHATS_PANEL = "chats" as const;
export const CHARACTERS_PANEL = "characters" as const;
export const SETTINGS_PANEL = "settings" as const;
export const MEMORY_PANEL = "memory" as const;
/**
 * The read-only preset surface (`design/architecture/tavern-preset-compatibility.md` §2.1).
 *
 * It is a peer surface with no editor: presets are imported once and read from then on, so this one
 * only shows the assembly's own facts about them.
 */
export const PRESETS_PANEL = "presets" as const;

/** The panel the URL currently names, or null for the conversation itself. */
function readPanelFromUrl(): string | null {
  return new URLSearchParams(window.location.hash.slice(1)).get(PANEL_PARAM);
}

/**
 * A surface switch, marked so a reader can time the switch itself rather than the first navigation.
 *
 * `gamebuddy:switch:<surface>:start` is recorded where the player selects a surface and
 * `gamebuddy:switch:<surface>:done` where the new region is committed - the two ends of one switch,
 * named the way `turn-timings.ts` names the ends of a turn, so one reader can pair both families.
 *
 * `done` is the COMMIT: React has rendered the new surface and the browser has painted it, because a
 * passive effect runs after the commit's paint. It is not "the surface's data arrived" - a surface
 * that mounts and then fetches is done switching while it is still fetching, and calling that
 * unfinished would make a switch appear to last as long as the Host took to answer it. A reader that
 * wants content arrival is asking for a different mark that nobody takes yet.
 *
 * Every `start` closes. A press that selects the surface already filling the region has no region
 * change below it to wait for - the default conversation is the case, and it has no entry in the URL
 * until a press writes one - so its commit is the press itself and its `done` is recorded there. Left
 * to the effect above, the app's first press was a `start` that never closed: the observation reader
 * pairs the ends and reports that shape as a switch with no duration. The first paint marks nothing on
 * either end: nobody selected it.
 *
 * `done` may also arrive with no `start`: Back and Escape move the history entry, not the player's
 * press on an entry. A reader that needs both ends omits those, which is the truth about them -
 * inventing a start for them would describe a selection that never happened.
 */
const SWITCH_MARK_PREFIX = "gamebuddy:switch:";

function markSwitch(surface: string, stage: "start" | "done"): void {
  if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
  performance.mark(`${SWITCH_MARK_PREFIX}${surface}:${stage}`, { detail: { surface } });
}

/**
 * The selected surface is a URL history entry rather than hidden state, so Back
 * moves between surfaces, Escape returns to the conversation, and a refresh comes
 * back with the same surface open (design/26 §7.2, design/104 §2). The shell owns
 * this one behaviour for every surface; the entries themselves are its surface
 * switcher.
 *
 * `returnFocusTo` is where a return to the conversation lands: the conversation's own field, which
 * the mount hands down (`Composer`'s ref, through `ChatSurface`). It is a ref rather than a selector
 * because the place is the product's to name - the shell used to reach it by the class the composer
 * renders, so renaming that class would have silently dropped the keyboard player on `<body>`.
 */
export function useSurfaceRoute(options: Readonly<{ returnFocusTo?: RefObject<HTMLElement | null> }> = {}): Readonly<{
  shownSurface: string;
  openPanelOf: (panel: string, entryRef: React.RefObject<HTMLButtonElement | null>) => () => void;
}> {
  const returnFocusTo = options.returnFocusTo;
  // The open contextual panel, as the URL states it. A refresh with
  // `#…&panel=game` comes back with the drawer already open.
  const [openPanel, setOpenPanel] = useState<string | null>(() => readPanelFromUrl());
  // The surface occupying the main region. Chat is the default surface, not a
  // privileged one: every surface takes the same region, and the URL names the
  // selected one so Back returns to the previous surface.
  const shownSurface = openPanel ?? CHAT_PANEL;

  // Browser Back moves between surfaces, because the selected surface is a
  // history entry rather than hidden state (design/26 §7.2). Escape returns to
  // the conversation from any other surface.
  useEffect(() => {
    const syncPanelWithHistory = (): void => setOpenPanel(readPanelFromUrl());
    window.addEventListener("popstate", syncPanelWithHistory);
    return () => window.removeEventListener("popstate", syncPanelWithHistory);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (shownSurface === CHAT_PANEL) return;
      // Stepping the history back removes the entry that selected this surface,
      // so a later refresh cannot resurrect it; a surface restored from a URL
      // this session never pushed returns to the conversation in place instead.
      if (window.history.state?.gbPanel !== undefined) {
        window.history.back();
        return;
      }
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.slice(1));
      params.delete(PANEL_PARAM);
      url.hash = params.toString();
      window.history.replaceState(null, "", url.toString());
      setOpenPanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shownSurface]);

  // Returning to the conversation puts the player back where they type. A
  // surface's own landing place is its heading (`SurfaceView`), which is right
  // for a peer surface a keyboard user is stepping into; the conversation's
  // landing place is the composer's field, so the mount hands this hook the field
  // itself. Only a return moves focus; the first paint does not.
  const previousSurfaceRef = useRef<string>(shownSurface);
  useEffect(() => {
    const changed = previousSurfaceRef.current !== shownSurface;
    const returned = shownSurface === CHAT_PANEL && changed;
    previousSurfaceRef.current = shownSurface;
    if (changed) markSwitch(shownSurface, "done");
    if (returned) returnFocusTo?.current?.focus();
  }, [shownSurface, returnFocusTo]);

  // Selecting a surface is one history entry (design/104 §2). The entries are the
  // shell's surface switcher, so all of them share this one behaviour.
  const openPanelOf =
    (panel: string, entryRef: React.RefObject<HTMLButtonElement | null>): (() => void) =>
    (): void => {
      void entryRef;
      if (openPanel === panel) return;
      const url = new URL(window.location.href);
      const params = new URLSearchParams(url.hash.slice(1));
      params.set(PANEL_PARAM, panel);
      url.hash = params.toString();
      window.history.pushState({ gbPanel: panel }, "", url.toString());
      markSwitch(panel, "start");
      // A selection the region already shows commits with the press: the `[shownSurface]` effect
      // cannot observe it, because nothing it depends on changes, and a `start` left waiting on it
      // would stand unpaired forever.
      if (shownSurface === panel) markSwitch(panel, "done");
      setOpenPanel(panel);
    };

  return { shownSurface, openPanelOf };
}
